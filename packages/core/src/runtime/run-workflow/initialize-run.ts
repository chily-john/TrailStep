import { basename } from "node:path";

import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { createRunDirectory, readRunEvents } from "../artifacts/run-storage.js";
import type { Event, RunWorkflowOptions } from "./run-workflow.types.js";

export async function initializeRun<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<{
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
  readonly previousEvents: readonly Event[];
}> {
  const existingRunDir = options.resume?.runDir ?? options.retry?.runDir;
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

  const cwd = options.cwd ?? process.cwd();
  const runName = options.runName;
  if (runName === undefined) {
    throw new Error("Expected runName for a new workflow run.");
  }
  const { runId, runDir } = await createRunDirectory({ cwd, runName });
  return { runId, runName, runDir, previousEvents: [] };
}
