import type { Event } from "@trailstep/core";
import { isFailureLikeError, readFailureCode, readRunEvents } from "@trailstep/core";

export async function readDashboardRunEvents(runDir: string): Promise<Event[]> {
  try {
    return await readRunEvents(runDir);
  } catch (error) {
    if (isResumeTargetNotFound(error)) {
      return [];
    }

    throw error;
  }
}

export function streamRunEvents(options: {
  readonly runDir: string;
  readonly response: NodeJS.WritableStream;
  readonly pollMs?: number;
}): () => void {
  const seen = new Set<string>();
  let closed = false;
  let polling = false;

  const poll = async () => {
    if (closed || polling) {
      return;
    }

    polling = true;
    try {
      const events = await readDashboardRunEvents(options.runDir);
      for (const event of events) {
        if (seen.has(event.id)) {
          continue;
        }

        seen.add(event.id);
        options.response.write(`id: ${event.id}\n`);
        options.response.write(`event: trailstep-event\n`);
        options.response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      polling = false;
    }
  };

  void poll();
  const interval = setInterval(() => {
    void poll();
  }, options.pollMs ?? 1_000);

  return () => {
    closed = true;
    clearInterval(interval);
  };
}

function isResumeTargetNotFound(error: unknown): boolean {
  if (isFailureLikeError(error)) {
    return error.failure.code === "resume_target_not_found";
  }

  // Fall back to a code-only check: failures that crossed a serialization
  // boundary can lose their message while keeping the code.
  return readFailureCode(error) === "resume_target_not_found";
}
