import { basename } from "node:path";

import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { Event, RunWorkflowOptions } from "./run-workflow.types.js";
import { createRunDirectory, readRunEvents } from "../artifacts/run-storage.js";

export async function initializeRun<TInput extends PlainObject, TOutput extends PlainObject>(
  options: RunWorkflowOptions<TInput, TOutput>,
): Promise<{
  readonly runId: string;
  readonly runName: string;
  readonly runDir: string;
  readonly previousEvents: readonly Event[];
}> {
  if (options.resume) {
    const previousEvents = await readRunEvents(options.resume.runDir);
    const startedEvent = previousEvents.find((event) => event.type === "workflow.started");
    return {
      runId: startedEvent?.runId ?? basename(options.resume.runDir),
      runName: startedEvent?.runId ?? basename(options.resume.runDir),
      runDir: options.resume.runDir,
      previousEvents,
    };
  }

  const cwd = options.cwd ?? process.cwd();
  const { runId, runDir } = await createRunDirectory({ cwd, runName: options.runName });
  return { runId, runName: options.runName, runDir, previousEvents: [] };
}
