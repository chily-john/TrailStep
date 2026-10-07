#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Event, InteractiveProcessRunner, WorkingAgentProcessRunner } from "@trailstep/core";
import {
  type CliCommandContext,
  CliUsageError,
  type PackageCommandRunner,
  type TrailStepCliPrompts,
  usageText,
} from "./internals/command.types.js";
import { resolveCommand } from "./internals/command-registry.js";
import { CliInputError } from "./internals/commands/run/load-run-input.js";
import { CliConfigError } from "./internals/config/config.js";
import type { TrailStepDeprecationEntry } from "./internals/deprecation-scan/deprecation-scanner.js";
import { parseWorkflowId } from "./internals/workflow-reference/workflow-reference.js";
import { WorkflowResolutionError } from "./internals/workflow-resolution/workflow-resolution-error.js";

import type {
  SkillsCliProcessRunner,
  SkillsCliResolver,
} from "./internals/workflow-skills/skills-cli.js";

export { CliInputError, loadJsonInput } from "./internals/commands/run/load-run-input.js";
export type { InputSource } from "./internals/commands/run/run-command.types.js";
export type {
  LoadTrailStepProjectConfigOptions,
  TrailStepProjectConfig,
} from "./internals/config/config.js";
export {
  CliConfigError,
  loadTrailStepConfig,
  loadTrailStepProjectConfig,
} from "./internals/config/config.js";
export { type DiscoveredWorkflow, discoverWorkflows } from "./internals/discovery/discovery.js";
export type { WorkflowReference } from "./internals/workflow-reference/workflow-reference.types.js";
export { CliUsageError, parseWorkflowId, usageText, WorkflowResolutionError };

declare const process:
  | {
      argv: string[];
      exitCode?: number;
      cwd: () => string;
      env?: Record<string, string | undefined>;
    }
  | undefined;

export interface TrailStepCliIo {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
}

export interface TrailStepMainOptions {
  argv?: readonly string[];
  cwd?: string;
  homeDir?: string;
  io?: Partial<TrailStepCliIo>;
  eventSink?: (event: Event) => void | Promise<void>;
  env?: Record<string, string | undefined>;
  processRunner?: InteractiveProcessRunner;
  agentSessionTerminalRunner?: InteractiveProcessRunner;
  workingAgentProcessRunner?: WorkingAgentProcessRunner;
  skillsCliResolver?: SkillsCliResolver;
  skillsCliProcessRunner?: SkillsCliProcessRunner;
  runNameClock?: () => Date;
  runNameRandomSuffix?: () => string;
  prompts?: TrailStepCliPrompts;
  packageCommandRunner?: PackageCommandRunner;
  deprecationManifest?: readonly TrailStepDeprecationEntry[];
}

export async function main(options: TrailStepMainOptions = {}): Promise<number> {
  const argv = options.argv ?? process?.argv.slice(2) ?? [];
  const io: TrailStepCliIo = {
    writeLine: options.io?.writeLine ?? console.log,
    writeError: options.io?.writeError ?? console.error,
  };
  const cwd = options.cwd ?? process?.cwd() ?? ".";

  const context: CliCommandContext = {
    cwd,
    homeDir: options.homeDir,
    io,
    prompts: "prompts" in options ? options.prompts : createTerminalPrompts(),
    eventSink: options.eventSink,
    env: options.env ?? process?.env ?? {},
    processRunner: options.processRunner,
    agentSessionTerminalRunner: options.agentSessionTerminalRunner,
    workingAgentProcessRunner: options.workingAgentProcessRunner,
    skillsCliResolver: options.skillsCliResolver,
    skillsCliProcessRunner: options.skillsCliProcessRunner,
    runNameClock: options.runNameClock,
    runNameRandomSuffix: options.runNameRandomSuffix,
    packageCommandRunner: options.packageCommandRunner,
    deprecationManifest: options.deprecationManifest,
  };

  try {
    if (argv.length === 1 && argv[0] === "--version") {
      const version = await resolveCliVersion();
      io.writeLine(version);
      return 0;
    }

    const command = resolveCommand(argv);
    const args = command.parseArgs(argv);
    return await command.run(args, context);
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof CliInputError ||
      error instanceof CliConfigError ||
      error instanceof WorkflowResolutionError
    ) {
      io.writeError(error.message);
      let cause = error.cause;
      while (cause instanceof Error) {
        io.writeError(`Caused by: ${cause.message}`);
        cause = cause.cause;
      }
      return 1;
    }

    throw error;
  }
}

export function runTrailStepCli(writeLine: (line: string) => void = console.log): Promise<number> {
  return main({ io: { writeLine } });
}

function createTerminalPrompts(): TrailStepCliPrompts {
  return {
    async text(prompt) {
      const { isCancel, text } = await import("@clack/prompts");
      const answer = await text({ message: prompt });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return String(answer);
    },
    async select(prompt, choices) {
      const { isCancel, select } = await import("@clack/prompts");
      const answer = await select({
        message: prompt,
        options: choices.map((choice) => ({ value: choice, label: choice })),
      });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return String(answer);
    },
    async multiSelect(prompt, choices) {
      const { isCancel, multiselect } = await import("@clack/prompts");
      const answer = await multiselect({
        message: prompt,
        options: choices.map((choice) => ({ value: choice, label: choice })),
        required: true,
      });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return answer.map(String);
    },
    async confirm(prompt) {
      const { confirm, isCancel } = await import("@clack/prompts");
      const answer = await confirm({ message: prompt });
      if (isCancel(answer)) {
        throw new CliUsageError(`Prompt cancelled: ${prompt}.`);
      }
      return answer;
    },
  };
}

async function resolveCliVersion(): Promise<string> {
  const packageRoot = await findCliPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
    throw new Error("Could not resolve @trailstep/cli package version.");
  }
  return packageJson.version;
}

async function findCliPackageRoot(startDirectory: string): Promise<string> {
  let current = startDirectory;
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
        readonly name?: string;
      };
      if (packageJson.name === "@trailstep/cli") {
        return current;
      }
    } catch {
      // Not a package root; continue walking up.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not resolve @trailstep/cli package root.");
    }
    current = parent;
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/?([A-Za-z]:)/u, "/$1");
}

const invokedScriptPath = process?.argv[1];
const metaPathNormalized = normalizePath(import.meta.url);
const metaBasename = metaPathNormalized.split("/").pop() ?? "";
const scriptBasename =
  normalizePath(invokedScriptPath || "")
    .split("/")
    .pop() ?? "";

if (invokedScriptPath && metaBasename === scriptBasename && metaBasename === "index.js") {
  void main().then((exitCode) => {
    if (process) {
      process.exitCode = exitCode;
    }
  });
}
