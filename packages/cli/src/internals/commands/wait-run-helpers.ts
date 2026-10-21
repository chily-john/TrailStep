import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findPendingWaitsById,
  isPathLike,
  type ResolvedRunDirectory,
  resolveRunDirectory as resolveRunDirectoryCore,
} from "@trailstep/core";
import type { CliCommandContext } from "../command.types.js";
import { CliUsageError } from "../command.types.js";

export type { ResolvedRunDirectory } from "@trailstep/core";
export {
  findLatestPendingWait,
  findPendingWaitsById,
  isPathLike,
  readEventsForRun,
  readWaitAnswerFile,
  waitEventBranchId,
  waitEventKey,
} from "@trailstep/core";

/**
 * Resolve a run name (under the runs root) or a run directory path.
 *
 * Thin CLI wrapper over the shared core resolution: the CLI keeps its
 * archived-run awareness, which turns an archived run into the
 * `trailstep storage restore <run>` usage hint instead of a missing run.
 */
export async function resolveRunDirectory(
  runNameOrRunDir: string,
  context: Pick<CliCommandContext, "cwd" | "env">,
): Promise<ResolvedRunDirectory> {
  return await resolveRunDirectoryCore(
    runNameOrRunDir,
    { cwd: context.cwd, env: context.env },
    {
      onRunNotFound: async ({ runNameOrRunDir: missingRun, runsRoot }) => {
        if (isPathLike(missingRun)) {
          return;
        }
        if (await hasArchivedRunManifest(runsRoot, missingRun)) {
          throw new CliUsageError(
            `Run ${missingRun} is archived. Restore it with:\n  trailstep storage restore ${missingRun}`,
          );
        }
      },
    },
  );
}

/** The last unresolved wait with the given wait id (CLI convenience wrapper). */
export function findPendingWaitById(
  events: Parameters<typeof findPendingWaitsById>[0],
  waitId: string,
): ReturnType<typeof findPendingWaitsById>[number] | undefined {
  const pending = findPendingWaitsById(events, waitId);
  return pending[pending.length - 1];
}

export async function writeRunWorkflowRef(runDir: string, workflowRef: string): Promise<void> {
  await writeFile(
    join(runDir, "workflow-ref.json"),
    `${JSON.stringify({ workflowRef }, null, 2)}\n`,
    "utf8",
  );
}

export async function readRunWorkflowRef(runDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(runDir, "workflow-ref.json"), "utf8"));
    if (isPlainObject(parsed) && typeof parsed.workflowRef === "string") {
      return parsed.workflowRef;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  return undefined;
}

async function hasArchivedRunManifest(runsRoot: string, runId: string): Promise<boolean> {
  try {
    await access(join(runsRoot, ".archive", `${runId}.manifest.json`), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
