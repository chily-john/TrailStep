import type { StorageLifecycleAction, StorageLifecyclePolicy } from "@trailstep/core";
import {
  applyStorageLifecycle,
  deleteRun,
  pinRun,
  readStorageLifecycleStatus,
  restoreArchivedRun,
  unpinRun,
} from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { loadTrailStepConfig } from "../../config/config.js";
import { resolveRunsRoot } from "../../runs-root.js";

interface StorageArgs {
  readonly subcommand?: "status" | "gc" | "restore" | "pin" | "unpin" | "delete";
  readonly runId?: string;
  readonly dryRun?: boolean;
}

const USAGE = `Usage: trailstep storage <status|gc|restore|pin|unpin|delete> [options]

Commands:
  trailstep storage status
  trailstep storage gc --dry-run
  trailstep storage gc
  trailstep storage restore <runId>
  trailstep storage pin <runId>
  trailstep storage unpin <runId>
  trailstep storage delete <runId>`;

export const storageCommand: CliCommand<StorageArgs> = {
  name: "storage",
  parseArgs(argv) {
    if (argv[0] !== "storage") {
      throw new CliUsageError("Expected storage command.");
    }
    const [subcommand, ...rest] = argv.slice(1);
    if (subcommand === undefined) {
      return {};
    }
    if (!isStorageSubcommand(subcommand)) {
      throw new CliUsageError(USAGE);
    }
    if (subcommand === "gc") {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--dry-run")) {
        throw new CliUsageError("Usage: trailstep storage gc [--dry-run]");
      }
      return { subcommand, dryRun: rest[0] === "--dry-run" };
    }
    if (subcommand === "status") {
      if (rest.length !== 0) {
        throw new CliUsageError("Usage: trailstep storage status");
      }
      return { subcommand };
    }
    if (rest.length !== 1 || !rest[0]) {
      throw new CliUsageError(`Usage: trailstep storage ${subcommand} <runId>`);
    }
    return { subcommand, runId: rest[0] };
  },
  async run(args, context) {
    const selected = args.subcommand ?? (await promptForStorageAction(context));
    if (selected === undefined) {
      context.io.writeLine(USAGE);
      return 0;
    }

    const runsRoot = resolveRunsRoot(context);
    const policy = await loadStorageLifecyclePolicy(context);

    if (selected === "status") {
      const status = await readStorageLifecycleStatus({ cwd: context.cwd, runsRoot, policy });
      context.io.writeLine(`Runs root: ${status.runsRoot}`);
      context.io.writeLine(`Lifecycle enabled: ${status.enabled ? "yes" : "no"}`);
      context.io.writeLine(`Hot runs: ${status.hotRuns}`);
      context.io.writeLine(`Archived runs: ${status.archivedRuns}`);
      context.io.writeLine(
        `Pinned runs: ${status.pinnedRuns.length ? status.pinnedRuns.join(", ") : "(none)"}`,
      );
      return 0;
    }

    if (selected === "gc") {
      const dryRun = args.dryRun ?? true;
      const actions = await applyStorageLifecycle({ cwd: context.cwd, runsRoot, policy, dryRun });
      writeActions(context, actions, dryRun ? "Would apply" : "Applied");
      if (policy.enabled !== true) {
        context.io.writeLine(
          "Lifecycle is disabled. Configure storage.lifecycle.enabled=true to allow gc.",
        );
      }
      return 0;
    }

    const runId = args.runId ?? (await promptForRunId(context, selected));
    if (!runId) {
      throw new CliUsageError(`trailstep storage ${selected} requires a run id.`);
    }

    if (selected === "restore") {
      await restoreArchivedRun({ runsRoot, runId });
      context.io.writeLine(`Restored archived run ${runId}.`);
    } else if (selected === "pin") {
      await pinRun({ runsRoot, runId });
      context.io.writeLine(`Pinned run ${runId}.`);
    } else if (selected === "unpin") {
      await unpinRun({ runsRoot, runId });
      context.io.writeLine(`Unpinned run ${runId}.`);
    } else if (selected === "delete") {
      await deleteRun({ runsRoot, runId });
      context.io.writeLine(`Deleted run ${runId}.`);
    }
    return 0;
  },
};

async function loadStorageLifecyclePolicy(
  context: CliCommandContext,
): Promise<StorageLifecyclePolicy> {
  const config = await loadTrailStepConfig(context.cwd, { homeDir: context.homeDir });
  const lifecycle = config?.storage?.lifecycle;
  if (lifecycle === undefined) {
    return {};
  }

  return {
    ...(lifecycle.enabled === undefined ? {} : { enabled: lifecycle.enabled }),
    ...(toPolicyDays(readLifecycleDuration(lifecycle, "compressAfter")) === undefined
      ? {}
      : { archiveAfterDays: toPolicyDays(readLifecycleDuration(lifecycle, "compressAfter")) }),
    ...(toPolicyDays(readLifecycleDuration(lifecycle, "deleteAfter")) === undefined
      ? {}
      : { deleteAfterDays: toPolicyDays(readLifecycleDuration(lifecycle, "deleteAfter")) }),
    ...(lifecycle.workflows === undefined
      ? {}
      : {
          workflows: Object.fromEntries(
            Object.entries(lifecycle.workflows).map(([workflowId, workflowLifecycle]) => [
              workflowId,
              {
                ...(toPolicyDays(workflowLifecycle.compressAfter) === undefined
                  ? {}
                  : { archiveAfterDays: toPolicyDays(workflowLifecycle.compressAfter) }),
                ...(toPolicyDays(workflowLifecycle.deleteAfter) === undefined
                  ? {}
                  : { deleteAfterDays: toPolicyDays(workflowLifecycle.deleteAfter) }),
              },
            ]),
          ),
        }),
  } as StorageLifecyclePolicy;
}

function readLifecycleDuration(
  value: object,
  key: "compressAfter" | "deleteAfter",
): string | false | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" || field === false ? field : undefined;
}

function toPolicyDays(value: string | false | undefined): number | false | undefined {
  if (value === false) {
    return false;
  }
  return typeof value === "string" ? durationDays(value) : undefined;
}

function durationDays(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return undefined;
  }
  const unit = match[2] as "ms" | "s" | "m" | "h" | "d" | "w";
  const daysByUnit: Record<typeof unit, number> = {
    ms: 1 / 86_400_000,
    s: 1 / 86_400,
    m: 1 / 1_440,
    h: 1 / 24,
    d: 1,
    w: 7,
  };
  return amount * daysByUnit[unit];
}

function writeActions(
  context: CliCommandContext,
  actions: readonly StorageLifecycleAction[],
  verb: string,
): void {
  if (actions.length === 0) {
    context.io.writeLine(`${verb}: no storage lifecycle actions.`);
    return;
  }
  for (const action of actions) {
    context.io.writeLine(`${verb}: ${action.action} ${action.runId} (${action.reason})`);
  }
}

async function promptForStorageAction(
  context: CliCommandContext,
): Promise<StorageArgs["subcommand"] | undefined> {
  if (context.prompts === undefined) {
    return undefined;
  }
  const selection = await context.prompts.select("Storage action", [
    "status",
    "gc",
    "restore",
    "pin",
    "unpin",
    "delete",
  ]);
  return isStorageSubcommand(selection) ? selection : undefined;
}

async function promptForRunId(
  context: CliCommandContext,
  action: string,
): Promise<string | undefined> {
  return context.prompts?.text(`Run id to ${action}`);
}

function isStorageSubcommand(value: string): value is NonNullable<StorageArgs["subcommand"]> {
  return ["status", "gc", "restore", "pin", "unpin", "delete"].includes(value);
}
