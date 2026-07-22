import type { Event } from "@stepkit/core";

import type { StepkitCliIo } from "../../command.types.js";

export function createTerminalEventLogger(io: StepkitCliIo): (event: Event) => void {
  return (event) => {
    const line = formatEvent(event);
    if (line !== undefined) {
      io.writeLine(line);
    }
  };
}

function formatEvent(event: Event): string | undefined {
  switch (event.type) {
    case "step.started": {
      const stepName =
        typeof event.payload.stepName === "string" ? event.payload.stepName : event.stepId;
      const kind = typeof event.payload.kind === "string" ? ` (${event.payload.kind})` : "";
      return `→ ${stepName}${kind}`;
    }
    case "step.completed":
      return `✓ ${event.stepId}`;
    case "step.failed": {
      const failure = event.payload.failure;
      const message =
        typeof failure === "object" &&
        failure !== null &&
        "message" in failure &&
        typeof failure.message === "string"
          ? `: ${failure.message}`
          : "";
      return `✗ ${event.stepId}${message}`;
    }
    default:
      return undefined;
  }
}
