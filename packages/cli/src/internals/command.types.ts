import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@trailstep/core";
import type { TrailStepDeprecationEntry } from "./deprecation-scan/deprecation-scanner.js";
import type { SkillsCliProcessRunner, SkillsCliResolver } from "./workflow-skills/skills-cli.js";

export const usageText = [
  "Usage:",
  "  trailstep",
  "  trailstep <agent-or-provider>",
  "  trailstep open [agent-or-provider]",
  "  trailstep add <workflow-file-bundle-or-package> [--scope <local|project|global>] [--namespace <namespace>] [--name <name>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force] [--yes] [--dry-run]",
  "  trailstep remove <namespace>/<name> [--scope <local|project|global>]",
  "  trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]",
  "  trailstep agents",
  "  trailstep agents set <name> --provider <provider> [--model <model>] [--thinking <low|medium|high|xhigh|max>] --scope <local|project|global>",
  "  trailstep agents delete <name> --scope <local|project|global>",
  "  trailstep agents rename <old> <new> --scope <local|project|global>",
  "  trailstep agents explain <name> --scope <local|project|global> explains one agent entry, its resolved targets, and its referrers.",
  "  trailstep agents explain <namespace>/<name> explains a registered workflow's agent roles, configured targets/refs, and final resolved provider/model targets.",
  "  trailstep providers [provider] [--scope <local|project|global>]",
  "  trailstep providers show [provider] [--scope <local|project|global>]",
  "  trailstep providers inspect <path-or-package>",
  "  trailstep providers add <path-or-package> [--scope <local|project|global>]",
  "  trailstep providers list [--scope <local|project|global>]",
  "  trailstep providers test <provider> [--scope <local|project|global>]",
  "  trailstep providers migrate [--scope <local|project|global>]",
  "  trailstep providers remove <provider> [--scope <local|project|global>]",
  "  trailstep workflows",
  "  trailstep input-template <workflow-ref>",
  "  trailstep output <runNameOrRunDir> [--json] [--field <path>]",
  "  trailstep watch <runNameOrRunDir> [--json | --jsonl] [--since beginning] [--follow | --no-follow]",
  "  trailstep continue",
  "  trailstep continue <runNameOrRunDir>",
  "  trailstep continue --interactive-file <path>",
  "  trailstep continue --session-file <path>",
  "  trailstep continue --json-file <path>",
  "  trailstep continue --json '<json>'",
  "  trailstep answer <runNameOrRunDir> <waitId> [--json '<json>' | --json-file <path>] [--branch <branchId>] [--continue]",
  "  trailstep cancel <runNameOrRunDir> [--reason '<text>']",
  "  trailstep cancel [--reason '<text>']",
  "  trailstep doctor",
  "  trailstep update [--all | --project | --workflows | --workflow <name>] [--force] [--yes | --assume-yes]",
  "  trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path|->] [--set <path=value>] [--<input-key> <value>]",
  "  trailstep retry <workflow-ref> <runName> [--failed | --branch <branchId> | --fresh]",
  "  trailstep runs",
  "  trailstep storage status",
  "  trailstep storage gc [--dry-run]",
  "  trailstep storage restore <runId>",
  "  trailstep storage pin <runId>",
  "  trailstep storage unpin <runId>",
  "  trailstep storage delete <runId>",
  "",
  "trailstep add defaults: scope prompts interactively when omitted (or uses project with --yes); namespace",
  'defaults to "project" for --scope project/local, or to "global" for --scope global',
  "unless you opt into a custom one; name defaults to the workflow's own id.",
  "For bundle packages with multiple workflows, --workflow accepts one name, a comma-separated",
  "list such as --workflow review,release,cleanup, or --workflow '*' for every workflow.",
  "Direct source refs may point at .ts/.mts/.js/.mjs files or source directories; append",
  "path#exportName to select a named export when a file or directory exports multiple workflows.",
  "",
  "Package-backed workflow lifecycle:",
  "  trailstep add accepts versioned npm package specs and github:<owner>/<repo> package specs; --dry-run is package-backed and non-mutating.",
  "  Package-backed add installs into the selected scope root, discovers workflows, and stores package metadata with registrations.",
  "  trailstep remove deletes the registration, then uninstalls only orphaned TrailStep-owned package installs; user-owned, stale, missing, or still-referenced installs are preserved.",
  "  trailstep update updates the globally installed TrailStep CLI binary only and refreshes tracked packaged skill installs when possible; it does not mutate project authoring/runtime dependencies.",
  "  trailstep update --project plans TrailStep project package updates for @trailstep/core, @trailstep/authoring, and @trailstep/cli in package.json.",
  "  trailstep update --workflows plans npm-backed workflow package updates from registered metadata across project and global install roots.",
  "  trailstep update --workflow <name> updates one registered workflow package target; local-file refs are skipped because they have no package version.",
  "  trailstep update --all combines global CLI, project TrailStep package, and workflow package updates per install root.",
  "  trailstep doctor also reports stale package recommendedConfig entries for registered package workflows.",
  "  Updates prompt before writing unless --yes or --assume-yes is passed; --force only bypasses blocking deprecation preflight.",
  "  GitHub-sourced workflow package updates are not supported yet and are skipped with a message.",
  "",
  "Run artifact storage lifecycle:",
  '  Configure storage.lifecycle with duration strings such as compressAfter: "7d" and deleteAfter: "30d"; per-workflow overrides live under storage.lifecycle.workflows.',
  "  trailstep storage status reports hot, archived, and pinned runs; trailstep storage gc applies the configured lifecycle and skips pinned runs.",
  "  trailstep storage restore refuses to overwrite an existing hot run and removes the archive copy after success.",
  "  trailstep storage pin/unpin operate on hot runs; restore archived runs before pinning or unpinning them.",
  "  trailstep storage delete removes hot or archived runs but refuses pinned runs.",
  "",
  "Managed agent sessions:",
  "  trailstep opens agents.default[0] as a standalone inherited-stdio session; run trailstep init or trailstep agents if no default is configured.",
  "  trailstep <agent-or-provider> opens an unambiguous configured agent or provider shortcut; workflow-only refs still run workflows, and ambiguous bare names require explicit syntax.",
  "  trailstep open [agent-or-provider] is the canonical standalone session command and never runs workflows.",
  "  Standalone sessions are not workflow runs and write artifacts under .trailstep/sessions/<session-id>/.",
  "",
  "Agent provider defaults:",
  "  Omit a model override or reasoning/thinking override to use provider defaults.",
  '  Interactive prompts label this choice "Use provider default"; empty model overrides',
  "  in config are treated as omitted.",
  "  Thinking availability is provider-aware: Pi and Claude expose TrailStep-supported",
  "  levels; Codex omits max; Gemini currently has no confirmed thinking flag.",
  "  Pi model discovery is best-effort; TrailStep offers discovered choices when",
  "  available and falls back to manual entry without maintaining a hardcoded model catalog.",
  "",
  "Custom provider templates:",
  "  Working args may use {{promptFile}}, {{outputFile}}, {{model}}, and {{thinking}};",
  "  interactive args may also use {{prompt}} for inline prompt input.",
  "  Guard optional overrides with {{#model}} ... {{/model}} and",
  "  {{#thinking}} ... {{/thinking}} conditional blocks.",
  "  Unguarded {{model}} or {{thinking}} placeholders error when that override is absent.",
  "",
  "Workflow refs:",
  "  ./workflow.ts#reviewWorkflow      direct local TypeScript file export",
  "  ./workflows#takeItAway            direct local source directory export",
  "  ./workflow.mjs                    direct local workflow file",
  "  project/review                    registered project workflow",
  "  global/cleanup                    registered global workflow",
  "  @acme/workflows#release           bundle manifest workflow",
  "  @acme/workflows:releaseWorkflow   legacy package export compatibility",
].join("\n");

export class CliUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${usageText}`);
    this.name = "CliUsageError";
  }
}

export interface TrailStepCliIo {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

export interface TrailStepCliPrompts {
  text: (prompt: string) => Promise<string>;
  select: (prompt: string, choices: readonly string[]) => Promise<string>;
  multiSelect?: (prompt: string, choices: readonly string[]) => Promise<readonly string[]>;
  confirm?: (prompt: string) => Promise<boolean>;
}

export interface PackageCommandRequest {
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface PackageCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type PackageCommandRunner = (
  request: PackageCommandRequest,
) => Promise<PackageCommandResult>;

export type ProviderBinaryResolver = (
  binary: string,
  context: CliCommandContext,
) => Promise<boolean>;

export interface CliCommandContext {
  cwd: string;
  homeDir?: string;
  io: TrailStepCliIo;
  prompts?: TrailStepCliPrompts;
  eventSink?: (event: Event) => void | Promise<void>;
  env?: Record<string, string | undefined>;
  providerBinaryResolver?: ProviderBinaryResolver;
  processRunner?: InteractiveProcessRunner;
  agentSessionTerminalRunner?: InteractiveProcessRunner;
  workingAgentProcessRunner?: WorkingAgentProcessRunner;
  skillsCliResolver?: SkillsCliResolver;
  skillsCliProcessRunner?: SkillsCliProcessRunner;
  runNameClock?: () => Date;
  runNameRandomSuffix?: () => string;
  packageCommandRunner?: PackageCommandRunner;
  deprecationManifest?: readonly TrailStepDeprecationEntry[];
}

export interface CliCommand<TArgs> {
  name: string;
  parseArgs(argv: readonly string[]): TArgs;
  run(args: TArgs, context: CliCommandContext): Promise<number>;
}
