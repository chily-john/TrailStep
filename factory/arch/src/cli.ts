/**
 * The architecture CLI entrypoint (Story 106).
 *
 * Thin by design: this file parses arguments, wires the real repository seams
 * (git, the core tsconfig, the scorecard artifact), and chooses an exit code.
 * The graph, rules, scorecard, SARIF renderer, changed-file scoping, and
 * explainer stay in sibling modules so they remain unit-testable without this
 * process contract.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, type RuleId } from "./arch/manifest.js";
import { RULE_FIXTURES, runRuleOnFixture } from "./arch/rules/fixtures.test.support.js";
import {
  type CheckFinding,
  type Diagnostic,
  diagnosticJson,
  findingJson,
  isStrictRuleId,
  renderDiagnostic,
  renderFinding,
  resolutionErrorDiagnostics,
  scopeOperationalDiagnostics,
  scorecardJson,
} from "./arch/rules/index.js";
import { SKILL_ARTIFACT_PATH, writeSkill } from "./arch/skill.js";
import { type CliOptions, CliUsageError, helpText, parseCliArgs } from "./cli-args.js";
import {
  type ChangedFiles,
  type GitRunner,
  hasStrictViolations,
  listChangedFiles,
  scopeDiagnosticsToTouched,
} from "./cli-changed.js";
import { type ExplainExample, isKnownRule, knownRuleIds, renderExplain } from "./cli-explain.js";
import {
  type ArchReport,
  type ArchReportPaths,
  coreTsconfigPath,
  DEFAULT_SCORECARD_PATH,
  renderReport,
  runArchReport,
  writeScorecard,
} from "./cli-report.js";
import { renderSarif } from "./cli-sarif.js";
import { findRepoRoot } from "./repo/root.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
}

export interface CliDeps {
  readonly io: CliIo;
  readonly repoRoot: string;
  /** Injectable only for tests; production uses the real git subprocess. */
  readonly git?: GitRunner;
  /** Injectable only for tests; production builds the real core graph. */
  readonly report?: (paths: ArchReportPaths) => ArchReport;
}

function explainExample(rule: RuleId): ExplainExample | null {
  if (!isStrictRuleId(rule)) {
    return null;
  }
  const fixture = RULE_FIXTURES[rule];
  const diagnostics = runRuleOnFixture(rule, fixture.fail);
  return {
    passFiles: Object.keys(fixture.pass.files).sort(),
    failFiles: Object.keys(fixture.fail.files).sort(),
    diagnostic: diagnostics[0] ?? null,
  };
}

function explainRule(rule: string, deps: CliDeps): number {
  if (!isKnownRule(manifest, rule)) {
    deps.io.stderr(
      `arch:explain: unknown rule "${rule}". Known rules: ${knownRuleIds(manifest).join(", ")}\n`,
    );
    return 1;
  }
  deps.io.stdout(renderExplain(manifest, rule, explainExample(rule)));
  return 0;
}

function createReport(deps: CliDeps, paths: ArchReportPaths): ArchReport {
  return (deps.report ?? runArchReport)(paths);
}

function displayPath(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

function scorecardPathFor(options: CliOptions, deps: CliDeps): string {
  return options.out !== null
    ? path.resolve(deps.io.cwd, options.out)
    : path.join(deps.repoRoot, DEFAULT_SCORECARD_PATH);
}

function runReportMode(options: CliOptions, deps: CliDeps, paths: ArchReportPaths): number {
  const report = createReport(deps, paths);
  const scorecardPath = scorecardPathFor(options, deps);
  writeScorecard(report.scorecard, scorecardPath);

  if (options.format === "json") {
    deps.io.stdout(`${scorecardJson(report.scorecard)}\n`);
  } else if (options.format === "sarif") {
    deps.io.stdout(
      `${renderSarif(manifest, [
        ...report.diagnostics,
        ...resolutionErrorDiagnostics(report.graph.resolutionErrors),
      ])}\n`,
    );
  } else {
    deps.io.stdout(renderReport(report, displayPath(deps.repoRoot, scorecardPath)));
  }
  return 0;
}

/** The blocking full-tree mode: same scorecard, same diagnostics, verdict exit. */
function runCheckMode(options: CliOptions, deps: CliDeps, paths: ArchReportPaths): number {
  const report = createReport(deps, paths);
  const scorecardPath = scorecardPathFor(options, deps);
  writeScorecard(report.scorecard, scorecardPath);
  const blocking = hasStrictViolations(report.diagnostics);

  if (options.format === "json") {
    deps.io.stdout(
      `${JSON.stringify(
        {
          scorecard: report.scorecard,
          diagnostics: report.diagnostics.map(diagnosticJson),
        },
        null,
        2,
      )}\n`,
    );
  } else if (options.format === "sarif") {
    deps.io.stdout(`${renderSarif(manifest, report.diagnostics)}\n`);
  } else {
    deps.io.stdout(
      renderReport(report, displayPath(deps.repoRoot, scorecardPath), { blocking: true }),
    );
    deps.io.stdout(renderCheckDiagnostics(report.diagnostics, blocking));
  }

  return blocking ? 1 : 0;
}

/**
 * The full diagnostic list after the scorecard. Check and report mode share
 * the diagnostic set; only the verdict and exit code differ.
 */
function renderCheckDiagnostics(diagnostics: readonly Diagnostic[], blocking: boolean): string {
  const lines = ["", "Full diagnostics — full tree:"];
  if (diagnostics.length === 0) {
    lines.push("  No strict violations.");
  } else {
    lines.push(diagnostics.map(renderDiagnostic).join("\n\n"));
  }
  const strictCount = diagnostics.filter((diagnostic) => diagnostic.set === "hard").length;
  lines.push(
    "",
    blocking
      ? `Verdict: ${strictCount} strict violation(s) — blocking.`
      : "Verdict: no strict violations — clean.",
  );
  return `${lines.join("\n")}\n`;
}

function renderChangedHeader(changed: ChangedFiles, report: ArchReport): string {
  const analyzedFiles = new Set(report.graph.files.map((file) => file.path));
  const analyzed = changed.touched.filter((file) => analyzedFiles.has(file)).length;
  return [
    `arch:check --changed  base: ${changed.base}`,
    `  touched source files: ${changed.touched.length} (deleted excluded: ${changed.deleted.length}; non-source excluded: ${changed.nonSource.length})`,
    `  analyzed by the manifest: ${analyzed}; outside coverage: ${changed.touched.length - analyzed}`,
    "",
  ].join("\n");
}

function runChangedMode(options: CliOptions, deps: CliDeps, paths: ArchReportPaths): number {
  const changed = listChangedFiles(deps.repoRoot, deps.git, { base: options.base });

  // Zero touched source files is a clean answer, not a check to narrate.
  if (changed.touched.length === 0) {
    if (options.format === "json") {
      deps.io.stdout("[]\n");
    } else if (options.format === "sarif") {
      deps.io.stdout(`${renderSarif(manifest, [])}\n`);
    }
    return 0;
  }

  const report = createReport(deps, paths);
  const scoped: CheckFinding[] = [
    ...scopeDiagnosticsToTouched(report.diagnostics, changed.touched, {
      graph: report.graph,
    }),
    ...scopeOperationalDiagnostics(
      resolutionErrorDiagnostics(report.graph.resolutionErrors),
      changed.touched,
    ),
  ];

  if (options.format === "json") {
    deps.io.stdout(`${JSON.stringify(scoped.map(findingJson), null, 2)}\n`);
  } else if (options.format === "sarif") {
    deps.io.stdout(`${renderSarif(manifest, scoped)}\n`);
  } else {
    deps.io.stdout(renderChangedHeader(changed, report));
    if (scoped.length === 0) {
      deps.io.stdout("No strict violations in touched files.\n");
    } else {
      deps.io.stdout(`${scoped.map(renderFinding).join("\n\n")}\n`);
    }
  }

  return scoped.length > 0 ? 1 : 0;
}

/** `--emit-skill <path>`: regenerate the artifact, never build the graph. */
function runEmitSkillMode(options: CliOptions, deps: CliDeps): number {
  if (options.emitSkill === undefined) {
    deps.io.stderr("arch:check: --emit-skill requires a path.\n");
    return 2;
  }
  const target = path.resolve(deps.io.cwd, options.emitSkill);
  const bytes = writeSkill(manifest, target);
  const relative = displayPath(deps.repoRoot, target);
  const sanctioned = relative === SKILL_ARTIFACT_PATH ? " (the sanctioned artifact)" : "";
  deps.io.stdout(`arch:skill: wrote ${relative}${sanctioned} — ${bytes} bytes from the manifest\n`);
  return 0;
}

/** Runs one CLI invocation and returns its exit code (never throws for usage). */
export function runCli(argv: readonly string[], deps: CliDeps): number {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      deps.io.stderr(`arch:check: ${error.message}\n\n${helpText()}\n`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    deps.io.stdout(`${helpText()}\n`);
    return 0;
  }

  try {
    if (options.mode === "explain") {
      return explainRule(options.rule ?? "", deps);
    }
    if (options.mode === "emit-skill") {
      return runEmitSkillMode(options, deps);
    }
    const paths: ArchReportPaths = {
      repoRoot: deps.repoRoot,
      tsconfig: coreTsconfigPath(deps.repoRoot),
    };
    return options.mode === "changed"
      ? runChangedMode(options, deps, paths)
      : options.mode === "check"
        ? runCheckMode(options, deps, paths)
        : runReportMode(options, deps, paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.io.stderr(`arch:check: ${message}\n`);
    return 2;
  }
}

function defaultDeps(): CliDeps {
  return {
    repoRoot: findRepoRoot(),
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      cwd: process.cwd(),
    },
    git: undefined,
    report: undefined,
  };
}

export function isEntrypoint(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined) {
    return false;
  }
  try {
    const modulePath = realpathSync(fileURLToPath(moduleUrl));
    const entryPath = realpathSync(path.resolve(entry));
    return modulePath === entryPath;
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2), defaultDeps());
}
