import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { loadDirectWorkflowFile } from "../../workflow-resolution/direct-file-resolver.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";
import { WorkflowResolutionError } from "../../workflow-resolution/workflow-resolution-error.js";

interface AddCommandArgs {
  readonly source: string;
  readonly scope?: "project" | "user";
  readonly namespace?: string;
  readonly name?: string;
  readonly workflow?: string;
  readonly force: boolean;
}

interface ResolvedAddCommandArgs {
  readonly source: string;
  readonly scope: "project" | "user";
  readonly namespace: string;
  readonly name: string;
  readonly workflow?: string;
  readonly force: boolean;
}

export const addCommand: CliCommand<AddCommandArgs> = {
  name: "add",
  parseArgs(argv: readonly string[]): AddCommandArgs {
    if (argv[0] !== "add") {
      throw new CliUsageError("Expected add command.");
    }

    const source = argv[1];
    if (!source) {
      throw new CliUsageError(
        "stepkit add requires a workflow file, bundle path, or bundle package.",
      );
    }

    const flags = parseFlags(argv.slice(2));
    const scope = flags.scope;
    if (scope !== undefined && scope !== "project" && scope !== "user") {
      throw new CliUsageError("stepkit add requires --scope project or --scope user.");
    }

    return {
      source,
      ...(scope === undefined ? {} : { scope }),
      ...(flags.namespace === undefined ? {} : { namespace: flags.namespace }),
      ...(flags.name === undefined ? {} : { name: flags.name }),
      workflow: flags.workflow,
      force: flags.force === "true",
    };
  },
  async run(args: AddCommandArgs, context: CliCommandContext): Promise<number> {
    const resolvedArgs = await resolveInteractiveArgs(args, context);
    const targetRef = await validateAndBuildRegistryTarget(resolvedArgs, context.cwd, context);
    const configPath = configPathForScope(resolvedArgs.scope, context);
    const config = await readConfig(configPath);
    const workflows = toMutableWorkflowRegistry(config.workflows);
    const namespace = workflows[resolvedArgs.namespace] ?? {};

    if (!resolvedArgs.force && namespace[resolvedArgs.name] !== undefined) {
      throw new CliUsageError(
        `Workflow registration already exists: ${resolvedArgs.namespace}/${resolvedArgs.name}. Use --force to replace it.`,
      );
    }

    workflows[resolvedArgs.namespace] = { ...namespace, [resolvedArgs.name]: targetRef };
    await writeConfig(configPath, { ...config, workflows });
    context.io.writeLine(
      `Registered ${resolvedArgs.namespace}/${resolvedArgs.name} -> ${targetRef} in ${resolvedArgs.scope} config.`,
    );
    return 0;
  },
};

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--force") {
      flags.force = "true";
      continue;
    }

    if (
      option !== "--scope" &&
      option !== "--namespace" &&
      option !== "--name" &&
      option !== "--workflow"
    ) {
      throw new CliUsageError(`Unknown option for stepkit add: ${option ?? ""}`);
    }

    const value = argv[index + 1];
    if (!value) {
      throw new CliUsageError(`Missing value for ${option}.`);
    }

    flags[option.slice(2)] = value;
    index += 1;
  }

  return flags;
}

async function resolveInteractiveArgs(
  args: AddCommandArgs,
  context: CliCommandContext,
): Promise<ResolvedAddCommandArgs> {
  const prompts = context.prompts;
  const promptText = async (label: string, value: string | undefined): Promise<string> => {
    if (value !== undefined) {
      return value;
    }
    if (prompts === undefined) {
      throw new CliUsageError(`stepkit add requires --${label.toLowerCase()} <${label.toLowerCase()}>.`);
    }
    const answer = (await prompts.text(label)).trim();
    if (!answer) {
      throw new CliUsageError(`${label} is required.`);
    }
    return answer;
  };

  return {
    source: args.source,
    scope: args.scope ?? (await promptSelect("Config scope", ["project", "user"], prompts)),
    namespace: await promptText("Namespace", args.namespace),
    name: await promptText("Workflow name", args.name),
    workflow: args.workflow,
    force: args.force,
  };
}

async function promptSelect<T extends string>(
  label: string,
  choices: readonly T[],
  prompts: CliCommandContext["prompts"],
): Promise<T> {
  if (prompts === undefined) {
    throw new CliUsageError(`stepkit add requires ${label}.`);
  }
  const selected = await prompts.select(label, choices);
  if (!choices.includes(selected as T)) {
    throw new CliUsageError(`Invalid selection for ${label}: ${selected}`);
  }
  return selected as T;
}

async function validateAndBuildRegistryTarget(
  args: ResolvedAddCommandArgs,
  cwd: string,
  context: CliCommandContext,
): Promise<string> {
  if (await isBundleSource(args.source, cwd)) {
    const workflowNames = await readBundleWorkflowNames(args.source, cwd);
    const workflowName =
      args.workflow ??
      (workflowNames.length === 1
        ? workflowNames[0]
        : await promptSelect("Bundle workflow", workflowNames, context.prompts));

    if (!workflowName) {
      throw new CliUsageError(
        `Bundle ${args.source} contains multiple workflows. Choose one with --workflow <workflow>.`,
      );
    }

    if (!workflowNames.includes(workflowName)) {
      throw new WorkflowResolutionError(
        `Bundle manifest workflow key not found: ${workflowName} in ${args.source}`,
      );
    }

    return `${args.source}#${workflowName}`;
  }

  if (args.workflow !== undefined) {
    throw new CliUsageError("--workflow is only valid for bundle package registrations.");
  }

  await loadDirectWorkflowFile(args.source, { cwd });
  return args.source;
}

async function isBundleSource(source: string, cwd: string): Promise<boolean> {
  if (!isDirectWorkflowFileReference(source)) {
    return true;
  }

  try {
    return (await stat(resolve(cwd, source))).isDirectory();
  } catch {
    return false;
  }
}

async function readBundleWorkflowNames(source: string, cwd: string): Promise<string[]> {
  const packageJsonPath = resolveBundlePackageJsonPath(source, cwd);
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    throw new WorkflowResolutionError(
      `Unable to read bundle package manifest for ${source}: ${packageJsonPath}`,
      { cause: error },
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.stepkit) || !isRecord(parsed.stepkit.workflows)) {
    throw new WorkflowResolutionError(
      `Missing stepkit.workflows manifest metadata in bundle package: ${source}`,
    );
  }

  const workflows = parsed.stepkit.workflows;
  if (!Object.values(workflows).every((target) => typeof target === "string")) {
    throw new WorkflowResolutionError(
      `Invalid stepkit.workflows manifest metadata in bundle package: ${source}`,
    );
  }

  return Object.keys(workflows);
}

function resolveBundlePackageJsonPath(source: string, cwd: string): string {
  if (isDirectWorkflowFileReference(source)) {
    return resolve(cwd, source, "package.json");
  }

  try {
    return createRequire(resolve(cwd, "package.json")).resolve(`${source}/package.json`);
  } catch (error) {
    throw new WorkflowResolutionError(`Bundle package not found: ${source}`, { cause: error });
  }
}

function configPathForScope(scope: ResolvedAddCommandArgs["scope"], context: CliCommandContext): string {
  const baseDir = scope === "project" ? context.cwd : (context.homeDir ?? homedir());
  return join(baseDir, ".stepkit", "config.json");
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new CliUsageError(`Invalid StepKit config at ${path}: expected a JSON object.`);
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeConfig(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toMutableWorkflowRegistry(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }

  const registry: Record<string, Record<string, unknown>> = {};
  for (const [namespace, entries] of Object.entries(value)) {
    if (isRecord(entries)) {
      registry[namespace] = { ...entries };
    }
  }
  return registry;
}

function isNodeError(error: unknown): error is { readonly code: string } {
  return isRecord(error) && typeof error.code === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
