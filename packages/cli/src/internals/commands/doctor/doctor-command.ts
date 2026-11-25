import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "@trailstep/core";

import {
  type CliCommand,
  type CliCommandContext,
  CliUsageError,
} from "../../command-framework/command.types.js";
import { formatDeprecationFinding } from "../../deprecation-scan/deprecation-formatter.js";
import {
  type DeprecationFinding,
  scanWorkflowSourceForDeprecations,
} from "../../deprecation-scan/deprecation-scanner.js";
import { resolveInstalledTrailStepVersions } from "../../deprecation-scan/resolve-installed-trailstep-versions.js";
import { resolveDeprecationScanTargets } from "../../deprecation-scan/scan-targets.js";
import { workflowPackageInstallRootForMetadata } from "../../workflow-packages/install-root.js";
import {
  configPathForScope,
  listRegisteredWorkflowEntries,
  readRawTrailStepConfigFile,
  type WorkflowPackageRegistryMetadata,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";

interface DoctorCommandArgs {
  readonly includeDiscovered: boolean;
}

interface RecommendedConfigPlan {
  readonly packageName: string;
  readonly agents: Record<string, unknown>;
  readonly workflows: Record<string, unknown>;
}

export const doctorCommand: CliCommand<DoctorCommandArgs> = {
  name: "doctor",
  parseArgs(argv) {
    if (argv[0] !== "doctor") {
      throw new CliUsageError("Expected doctor command.");
    }
    if (argv.length > 1) {
      throw new CliUsageError(`Unknown option: ${argv[1] ?? ""}`);
    }
    return { includeDiscovered: true };
  },
  async run(args, context) {
    const versionsByPackageName = await resolveInstalledTrailStepVersions({ cwd: context.cwd });
    const targets = await resolveDeprecationScanTargets({
      cwd: context.cwd,
      homeDir: context.homeDir,
      includeDiscovered: args.includeDiscovered,
    });
    const findings: DeprecationFinding[] = [];

    for (const target of targets) {
      try {
        findings.push(
          ...(await scanWorkflowSourceForDeprecations({
            sourceFile: target.sourceFile,
            versionsByPackageName,
            manifest: context.deprecationManifest,
          })),
        );
      } catch {
        // Doctor is advisory: unreadable scan targets are skipped until scanner coverage expands.
      }
    }

    const recommendedConfigWarnings = await findRecommendedConfigWarnings(context);
    const archLines = await reportArchChanged(context);

    for (const line of archLines) {
      context.io.writeLine(line);
    }
    for (const finding of findings) {
      context.io.writeLine(formatDeprecationFinding(finding));
    }
    for (const warning of recommendedConfigWarnings) {
      context.io.writeLine(warning);
    }

    if (findings.length === 0 && recommendedConfigWarnings.length === 0) {
      context.io.writeLine("No TrailStep deprecation findings.");
      return 0;
    }

    if (findings.some((finding) => finding.severity === "blocking")) {
      context.io.writeError("Doctor found blocking deprecation findings.");
      return 2;
    }

    if (recommendedConfigWarnings.length > 0 && findings.length === 0) {
      context.io.writeError("Doctor found recommended config warnings.");
      return 1;
    }

    context.io.writeError("Doctor found deprecation warnings.");
    return 1;
  },
};

async function findRecommendedConfigWarnings(
  context: CliCommandContext,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  const seenPackages = new Set<string>();

  for (const entry of await listRegisteredWorkflowEntries(context)) {
    const metadata = entry.packageMetadata;
    if (metadata === undefined) {
      continue;
    }

    const key = `${metadata.installScope}:${metadata.packageName}`;
    if (seenPackages.has(key)) {
      continue;
    }
    seenPackages.add(key);

    const plan = await readInstalledPackageRecommendedConfig(metadata, context);
    if (plan === undefined) {
      continue;
    }

    const config = await readRawTrailStepConfigFile(
      configPathForScope(metadata.installScope, context),
    );
    warnings.push(...diffRecommendedConfig(metadata.installScope, config, plan));
  }

  return warnings;
}

async function readInstalledPackageRecommendedConfig(
  metadata: WorkflowPackageRegistryMetadata,
  context: CliCommandContext,
): Promise<RecommendedConfigPlan | undefined> {
  const packageJsonPath = join(
    workflowPackageInstallRootForMetadata(metadata, context),
    "node_modules",
    ...metadata.packageName.split("/"),
    "package.json",
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  if (!isRecord(parsed) || !isRecord(parsed.trailstep)) {
    return undefined;
  }
  const recommendedConfig = parsed.trailstep.recommendedConfig;
  if (!isRecord(recommendedConfig)) {
    return undefined;
  }

  const agents = isRecord(recommendedConfig.agents) ? recommendedConfig.agents : {};
  const workflows = isRecord(recommendedConfig.workflows) ? recommendedConfig.workflows : {};
  if (Object.keys(agents).length === 0 && Object.keys(workflows).length === 0) {
    return undefined;
  }

  const packageName =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name
      : metadata.packageName;
  return { packageName, agents, workflows };
}

function diffRecommendedConfig(
  scope: WorkflowRegistryScope,
  config: Record<string, unknown>,
  plan: RecommendedConfigPlan,
): readonly string[] {
  const warnings: string[] = [];
  const agents = toMutableRecord(config.agents);
  const workflows = toMutableRecord(config.workflows);

  for (const [agentName, recommendedAgent] of Object.entries(plan.agents)) {
    const actualAgent = agents[agentName];
    if (actualAgent === undefined) {
      warnings.push(
        `Recommended config warning: ${plan.packageName} agents.${agentName} is missing in ${scope} config.`,
      );
    } else if (!jsonEqual(actualAgent, recommendedAgent)) {
      warnings.push(
        `Recommended config warning: ${plan.packageName} agents.${agentName} differs from the package recommendation in ${scope} config.`,
      );
    }
  }

  for (const [workflowId, recommendedWorkflow] of Object.entries(plan.workflows)) {
    if (!isRecord(recommendedWorkflow)) {
      continue;
    }
    const recommendedAgents = isRecord(recommendedWorkflow.agents)
      ? recommendedWorkflow.agents
      : {};
    const workflowConfig = toMutableRecord(workflows[workflowId]);
    const workflowAgents = toMutableRecord(workflowConfig.agents);
    for (const [roleName, recommendedRoleTargets] of Object.entries(recommendedAgents)) {
      const actualRoleTargets = workflowAgents[roleName];
      if (actualRoleTargets === undefined) {
        warnings.push(
          `Recommended config warning: ${plan.packageName} workflows.${workflowId}.agents.${roleName} is missing in ${scope} config.`,
        );
      } else if (!jsonEqual(actualRoleTargets, recommendedRoleTargets)) {
        warnings.push(
          `Recommended config warning: ${plan.packageName} workflows.${workflowId}.agents.${roleName} differs from the package recommendation in ${scope} config.`,
        );
      }
    }
  }

  return warnings;
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNodeError(error: unknown): error is { readonly code: string } {
  return isRecord(error) && typeof error.code === "string";
}

/**
 * The architecture seam (Story 110 AC 3).
 *
 * Doctor reports the same verdict the CI gate has — `arch:check --changed` —
 * and never gates on it: the exit code below is only ever cosmetic text, and a
 * missing or failing checker degrades to one line instead of failing doctor.
 *
 * Availability is looked up at the invocation's own project root and never in
 * an ancestor: doctor reports on the project it was pointed at, and a parent
 * repository's gate must never be run against a nested project. A project with
 * no `factory/arch` at all (every installed-user project) gets no line: there
 * is nothing for that project to check, so silence is the correct report.
 */
const ARCH_CLI_SEGMENTS = ["factory", "arch", "dist", "cli.js"] as const;
const ARCH_PACKAGE_SEGMENTS = ["factory", "arch", "package.json"] as const;
const ARCH_CHECK_TIMEOUT_MS = 30_000;

export interface ArchCheckOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ArchCheckSpawn = (input: {
  readonly cliPath: string;
  readonly cwd: string;
}) => Promise<ArchCheckOutcome>;

export type ArchCliAvailability =
  | { readonly status: "ready"; readonly cliPath: string }
  | { readonly status: "unbuilt" }
  | { readonly status: "absent" };

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    // Unreadable is not absent: let the spawn attempt report the real reason.
    return true;
  }
}

/** Classifies the project root: a built arch CLI, an unbuilt one, or neither. */
export async function locateArchCli(cwd: string): Promise<ArchCliAvailability> {
  const cliPath = join(cwd, ...ARCH_CLI_SEGMENTS);
  if (await pathExists(cliPath)) {
    return { status: "ready", cliPath };
  }
  if (await pathExists(join(cwd, ...ARCH_PACKAGE_SEGMENTS))) {
    return { status: "unbuilt" };
  }
  return { status: "absent" };
}

const NO_ARCH_VIOLATIONS = "arch:check --changed: no strict violations in touched files.";
const ARCH_REPORTING_NOTE =
  "arch:check --changed: reporting only; the CI gate is the blocking caller.";

/**
 * One arch violation, in doctor's own style: the same fields the CI gate prints,
 * including the diagnostic's one-line `Fix:` recipe. That recipe is the
 * remediation (the arch contract calls it the most valuable part), so dropping
 * it would leave a reader with the symptom and no remediation — doctor's
 * `formatDeprecationFinding` already appends `Replacement: …` for the same
 * reason. A diagnostic without a `fix` degrades to the bare line.
 */
function archViolationLine(diagnostic: Record<string, unknown>): string | null {
  // Manifest diagnostics carry `rule`; operational findings (an unresolved
  // import) carry a stable `code` instead. Accept both so doctor always shows
  // the file, position, message, and fix recipe.
  const rule =
    typeof diagnostic.rule === "string"
      ? diagnostic.rule
      : typeof diagnostic.code === "string"
        ? diagnostic.code
        : null;
  const file = typeof diagnostic.file === "string" ? diagnostic.file : null;
  if (rule === null || file === null) {
    return null;
  }
  const line = typeof diagnostic.line === "number" ? `:${diagnostic.line}` : "";
  const message = typeof diagnostic.message === "string" ? diagnostic.message : "";
  const fix =
    typeof diagnostic.fix === "string" && diagnostic.fix.length > 0
      ? `  Fix: ${diagnostic.fix}`
      : "";
  return `  ${rule}  ${file}${line}  ${message}${fix}`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  return line === undefined ? "" : line.trim();
}

/**
 * Renders one arch verdict. `--changed --json` is machine-read so a reworded
 * human rendering cannot change doctor's report; anything unreadable becomes a
 * single explicit line rather than a stack trace or a gating failure.
 */
export function summarizeArchCheck(
  availability: ArchCliAvailability,
  outcome: ArchCheckOutcome | { readonly error: string } | null,
): readonly string[] {
  if (availability.status === "absent") {
    return [];
  }
  if (availability.status === "unbuilt") {
    return [
      "arch:check --changed: not available (factory/arch is not built; run `pnpm --filter @trailstep/factory-arch build`).",
    ];
  }
  if (outcome === null) {
    return ["arch:check --changed: not run."];
  }
  if ("error" in outcome) {
    return [`arch:check --changed: not available (${outcome.error}).`];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    const detail =
      firstLine(outcome.stderr) || firstLine(outcome.stdout) || `exit ${outcome.exitCode}`;
    return [`arch:check --changed: no readable report (${detail}).`];
  }
  if (!Array.isArray(parsed)) {
    return ["arch:check --changed: no readable report (unexpected JSON shape)."];
  }

  const violationLines = parsed
    .filter((diagnostic): diagnostic is Record<string, unknown> => isRecord(diagnostic))
    .map(archViolationLine)
    .filter((line): line is string => line !== null);

  if (violationLines.length === 0) {
    return [NO_ARCH_VIOLATIONS];
  }
  return [
    `arch:check --changed: ${violationLines.length} strict violation(s) in touched files.`,
    ...violationLines,
    ARCH_REPORTING_NOTE,
  ];
}

const defaultArchCheckSpawn: ArchCheckSpawn = async ({ cliPath, cwd }) =>
  new Promise<ArchCheckOutcome>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--changed", "--json"], {
      cwd,
      shell: false,
      windowsHide: true,
      timeout: ARCH_CHECK_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });

/** The doctor's arch lines; empty when the project has no arch checker. */
export async function reportArchChanged(
  context: Pick<CliCommandContext, "cwd">,
  spawnArchCheck: ArchCheckSpawn = defaultArchCheckSpawn,
): Promise<readonly string[]> {
  const availability = await locateArchCli(context.cwd);
  if (availability.status !== "ready") {
    return summarizeArchCheck(availability, null);
  }
  try {
    const outcome = await spawnArchCheck({ cliPath: availability.cliPath, cwd: context.cwd });
    return summarizeArchCheck(availability, outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return summarizeArchCheck(availability, { error: message });
  }
}
