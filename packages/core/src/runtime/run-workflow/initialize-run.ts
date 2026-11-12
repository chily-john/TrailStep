import { basename } from "node:path";

import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { createRunDirectory, readRunEvents } from "../artifacts/run-storage.js";
import { resolveAndValidateRunCwds } from "./cwd.js";
import type { Event, RunWorkflowOptions } from "./run-workflow.types.js";
import { createInitialTrackState } from "./scheduler-track-state.js";

export async function initializeRun<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<{
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
  readonly previousEvents: readonly Event[];
}> {
  const existingRunDir =
    options.resume?.runDir ?? options.retry?.runDir ?? options.continue?.runDir;
  if (existingRunDir) {
    const previousEvents = await readRunEvents(existingRunDir);
    const startedEvent = previousEvents.find((event) => event.type === "workflow.started");
    return {
      runId: startedEvent?.runId ?? basename(existingRunDir),
      runName: startedEvent?.runId ?? basename(existingRunDir),
      runDir: existingRunDir,
      previousEvents,
    };
  }

  const { projectCwd } = await resolveAndValidateRunCwds(options);
  const runName = options.runName;
  if (runName === undefined) {
    throw new Error("Expected runName for a new workflow run.");
  }
  // The new-run branch is the only path that reaches `createRunDirectory`.
  // Resume/retry/continue returned above, so their existing terminal/waiting
  // track is never reset. The creation hook runs at the directory seam, before
  // any event can be emitted.
  const { runId, runDir } = await createRunDirectory({
    cwd: projectCwd,
    runName,
    runsRoot: options.runsRoot,
    initialTrackState: ({ runId }) =>
      createInitialTrackState({
        runId,
        workflowId: options.workflow.id,
      }),
  });
  return { runId, runName, runDir, previousEvents: [] };
}
