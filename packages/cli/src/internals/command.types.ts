import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@trailstep/core";
import type { TrailStepDeprecationEntry } from "./deprecation-scan/deprecation-scanner.js";
import type { SkillsCliProcessRunner, SkillsCliResolver } from "./workflow-skills/skills-cli.js";

export const usageText = [
  "Usage:",
  "  trailstep add <workflow-file-or-bundle> [--scope <local|project|global>] [--namespace <namespace>] [--name <name>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force]",
  "  trailstep remove <namespace>/<name> [--scope <local|project|global>]",
  "  trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]",
  "  trailstep agents",
  "  trailstep agents set <name> --provider <provider> --model <model> [--thinking <none|low|medium|high|xhigh|max>] --scope <local|project|global>",
  "  trailstep agents delete <name> --scope <local|project|global>",
  "  trailstep agents rename <old> <new> --scope <local|project|global>",
  "  trailstep workflows",
  "  trailstep continue",
  "  trailstep continue --interactive-file <path>",
  "  trailstep continue --session-file <path>",
  "  trailstep continue --json-file <path>",
  "  trailstep continue --json '<json>'",
  "  trailstep cancel [--reason '<text>']",
  "  trailstep doctor",
  "  trailstep update [--all | --workflows | --workflow <name>] [--force] [--assume-yes]",
  "  trailstep <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]",
  "  trailstep retry <workflow-ref> <runName>",
  "  trailstep runs",
  "",
  "trailstep add defaults: scope prompts interactively when omitted (no default); namespace",
  'defaults to "project" for --scope project/local, or to "global" for --scope global',
  "unless you opt into a custom one; name defaults to the workflow's own id.",
  "For bundle packages with multiple workflows, --workflow accepts one name, a comma-separated",
  "list such as --workflow review,release,cleanup, or --workflow '*' for every workflow.",
  "Direct source refs may point at .ts/.mts/.js/.mjs files or source directories; append",
  "path#exportName to select a named export when a file or directory exports multiple workflows.",
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

export interface CliCommandContext {
  cwd: string;
  homeDir?: string;
  io: TrailStepCliIo;
  prompts?: TrailStepCliPrompts;
  eventSink?: (event: Event) => void | Promise<void>;
  env?: Record<string, string | undefined>;
  processRunner?: InteractiveProcessRunner;
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
