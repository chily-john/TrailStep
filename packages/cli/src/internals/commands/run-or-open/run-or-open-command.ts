import type { TrailStepConfig } from "@trailstep/core";
import {
  AgentSessionTargetResolutionError,
  resolveAgentSessionTarget,
} from "../../agent-sessions/agent-session-target-resolution.js";
import { openAgentSession } from "../../agent-sessions/open-agent-session.js";
import { type CliCommand, CliUsageError } from "../../command.types.js";
import { loadTrailStepConfig } from "../../config/config.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { runCommand } from "../run/run-command.js";
import type { RunCommandArgs } from "../run/run-command.types.js";

export const runOrOpenCommand: CliCommand<RunCommandArgs> = {
  name: "run-or-open",
  parseArgs(argv) {
    return runCommand.parseArgs(argv);
  },
  async run(args, context) {
    const token = args.workflowId;
    if (
      isSimpleBareAgentOrProviderToken(token) &&
      !isKnownSubcommand(token) &&
      args.workflowRunName === undefined &&
      args.input === undefined
    ) {
      const config = await loadTrailStepConfig(context.cwd, { homeDir: context.homeDir });
      const workflow = await resolveWorkflowForBareToken(token, {
        cwd: context.cwd,
        homeDir: context.homeDir,
      });

      const agentTarget = resolveBareAgentSessionTarget(config, token);

      if (workflow !== undefined && agentTarget === "openable") {
        context.io.writeError(formatBareInvocationAmbiguity(token, workflow.id));
        return 1;
      }

      if (workflow === undefined && agentTarget !== "not-openable") {
        const result = await openAgentSession({
          cwd: context.cwd,
          config,
          requestedName: token,
          runner: context.agentSessionTerminalRunner,
          now: context.runNameClock,
          randomSuffix: context.runNameRandomSuffix,
        });

        if (!result.ok) {
          context.io.writeError(result.message);
          return result.exitCode;
        }

        if (result.exitCode === 0) {
          context.io.writeLine(
            `Opened TrailStep agent session ${result.sessionId} at ${result.sessionDir}`,
          );
        }

        return result.exitCode;
      }
    }

    return runCommand.run(args, context);
  },
};

async function resolveWorkflowForBareToken(
  token: string,
  options: { readonly cwd: string; readonly homeDir?: string },
) {
  try {
    return await resolveWorkflowReference(token, options);
  } catch (error) {
    if (isExpectedBareTokenWorkflowMiss(error)) {
      return undefined;
    }
    throw error;
  }
}

function isExpectedBareTokenWorkflowMiss(error: unknown): boolean {
  if (isPackageJsonNotFound(error)) {
    return true;
  }

  return (
    error instanceof CliUsageError &&
    error.message.startsWith(
      "Workflow id must include either package:workflowExport or package-or-path#workflowName.",
    )
  );
}

type BareAgentTargetProbe = "openable" | "not-openable" | "known-but-invalid";

function resolveBareAgentSessionTarget(
  config: TrailStepConfig | undefined,
  token: string,
): BareAgentTargetProbe {
  try {
    resolveAgentSessionTarget({ config, requestedName: token });
    return "openable";
  } catch (error) {
    if (
      error instanceof AgentSessionTargetResolutionError &&
      error.code === "target-not-openable"
    ) {
      return "not-openable";
    }

    return "known-but-invalid";
  }
}

function formatBareInvocationAmbiguity(token: string, workflowId: string): string {
  return [
    `Name is ambiguous: ${token} resolves as both an agent/provider and a workflow.`,
    `Use \`trailstep open ${token}\` to open the agent/provider.`,
    `Use an explicit workflow ref, such as \`${workflowId}\`, or the existing workflow invocation form to run the workflow.`,
  ].join("\n");
}

function isPackageJsonNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT" &&
    "path" in error &&
    typeof error.path === "string" &&
    error.path.endsWith("package.json")
  );
}

const KNOWN_SUBCOMMANDS = new Set([
  "run",
  "continue",
  "cancel",
  "runs",
  "retry",
  "doctor",
  "update",
  "agents",
  "workflows",
  "add",
  "remove",
  "init",
  "skill-check",
  "open",
]);

function isKnownSubcommand(token: string): boolean {
  return KNOWN_SUBCOMMANDS.has(token);
}

function isSimpleBareAgentOrProviderToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(token) && !token.startsWith("-");
}
