import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@stepkit/core";

import type { SkillsCliProcessRunner, SkillsCliResolver } from "./workflow-skills/skills-cli.js";

export const usageText = [
  "Usage:",
  "  stepkit add <workflow-file-or-bundle> --scope <project|project-local|user> --namespace <namespace> --name <name> [--workflow <workflow>] [--project-skill] [--user-skill] [--force]",
  "  stepkit list",
  "  stepkit continue --session-file <path>",
  "  stepkit continue --json-file <path>",
  "  stepkit continue --json '<json>'",
  "  stepkit <workflow-ref> [workflowRunName] [--input '<json>' | --input-file <path>]",
  "  stepkit <workflow-ref> <workflowRunName> --resume",
  "",
  "Workflow refs:",
  "  ./workflow.mjs                    direct local workflow file",
  "  project/review                    registered project workflow",
  "  user/cleanup                      registered user workflow",
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
}

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
}

export interface CliCommand<TArgs> {
  name: string;
  parseArgs(argv: readonly string[]): TArgs;
  run(args: TArgs, context: CliCommandContext): Promise<number>;
}
