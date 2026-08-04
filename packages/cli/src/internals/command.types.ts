import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@stepkit/core";
import type { StepKitDeprecationEntry } from "./deprecation-scan/deprecation-scanner.js";
import type { SkillsCliProcessRunner, SkillsCliResolver } from "./workflow-skills/skills-cli.js";

export const usageText = [
  "Usage:",
  "  stepkit add <workflow-file-or-bundle> [--scope <local|project|global>] [--namespace <namespace>] [--name <name>] [--workflow <workflow>] [--project-skill] [--user-skill] [--force]",
  "  stepkit remove <namespace>/<name> [--scope <local|project|global>]",
  "  stepkit init [--scope <local|project|global>]",
  "  stepkit agents",
  "  stepkit agents set <name> --provider <provider> --model <model> [--thinking <none|low|medium|high|xhigh|max>] --scope <local|project|global>",
  "  stepkit agents delete <name> --scope <local|project|global>",
  "  stepkit agents rename <old> <new> --scope <local|project|global>",
  "  stepkit workflows",
  "  stepkit continue",
  "  stepkit continue --interactive-file <path>",
  "  stepkit continue --session-file <path>",
  "  stepkit continue --json-file <path>",
  "  stepkit continue --json '<json>'",
  "  stepkit cancel [--reason '<text>']",
  "  stepkit doctor",
  "  stepkit update [--all | --workflows | --workflow <name>] [--force] [--assume-yes]",
  "  stepkit <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]",
  "  stepkit retry <workflow-ref> <runName>",
  "  stepkit runs",
  "",
  "stepkit add defaults: scope prompts interactively when omitted (no default); namespace",
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

export interface StepkitCliIo {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

export interface StepkitCliPrompts {
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
  io: StepkitCliIo;
  prompts?: StepkitCliPrompts;
  eventSink?: (event: Event) => void | Promise<void>;
  env?: Record<string, string | undefined>;
  processRunner?: InteractiveProcessRunner;
  workingAgentProcessRunner?: WorkingAgentProcessRunner;
  skillsCliResolver?: SkillsCliResolver;
  skillsCliProcessRunner?: SkillsCliProcessRunner;
  runNameClock?: () => Date;
  runNameRandomSuffix?: () => string;
  packageCommandRunner?: PackageCommandRunner;
  deprecationManifest?: readonly StepKitDeprecationEntry[];
}

export interface CliCommand<TArgs> {
  name: string;
  parseArgs(argv: readonly string[]): TArgs;
  run(args: TArgs, context: CliCommandContext): Promise<number>;
}
