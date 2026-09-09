import type { Event } from "@trailstep/core";

import type { TrailStepCliIo } from "../../command.types.js";

export function createTerminalEventLogger(io: TrailStepCliIo): (event: Event) => void {
  return (event) => {
    const lines = formatEvent(event);
    if (lines !== undefined) {
      for (const line of lines) {
        io.writeLine(line);
      }
    }
  };
}

function formatEvent(event: Event): readonly string[] | undefined {
  if (readEventType(event) === "workflow.cancelled") {
    const reason = typeof event.payload.reason === "string" ? `: ${event.payload.reason}` : "";
    return [`⊘ Workflow cancelled${reason}`];
  }

  switch (event.type) {
    case "step.started": {
      const stepName =
        typeof event.payload.title === "string"
          ? event.payload.title
          : typeof event.payload.stepName === "string"
            ? event.payload.stepName
            : event.stepId;
      const kind = typeof event.payload.kind === "string" ? ` (${event.payload.kind})` : "";
      const line = `→ ${stepName}${kind}`;
      return typeof event.payload.description === "string"
        ? [line, `  ${event.payload.description}`]
        : [line];
    }
    case "step.completed":
      return [`✓ ${event.stepId}`];
    case "step.failed": {
      const failure = event.payload.failure;
      const message =
        typeof failure === "object" &&
        failure !== null &&
        "message" in failure &&
        typeof failure.message === "string"
          ? `: ${failure.message}`
          : "";
      return [`✗ ${event.stepId}${message}`];
    }
    case "step.display": {
      const message = typeof event.payload.message === "string" ? event.payload.message : undefined;
      if (message === undefined) {
        return undefined;
      }

      const level = typeof event.payload.level === "string" ? event.payload.level : "info";
      const marker = level === "warning" || level === "error" ? "!" : "•";
      return [`${marker} ${message}`];
    }
    case "step.progress": {
      const message = typeof event.payload.message === "string" ? event.payload.message : undefined;
      return message === undefined ? undefined : [`• ${message}`];
    }
    case "step.warning": {
      const message = typeof event.payload.message === "string" ? event.payload.message : undefined;
      return message === undefined ? undefined : [`! ${message}`];
    }
    case "step.artifact": {
      const name = typeof event.payload.name === "string" ? event.payload.name : undefined;
      const path = typeof event.payload.path === "string" ? event.payload.path : undefined;
      if (name === undefined || path === undefined) {
        return undefined;
      }

      return [`↳ Artifact: ${name} — ${path}`];
    }
    case "wait.started": {
      const message = typeof event.payload.message === "string" ? event.payload.message : undefined;
      const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
      const label = waitId ? `Waiting for ${waitId}` : "Waiting";
      return message === undefined ? [`? ${label}`] : [`? ${label}: ${message}`];
    }
    case "wait.satisfied": {
      const waitId = typeof event.payload.waitId === "string" ? event.payload.waitId : undefined;
      return [waitId ? `✓ Wait satisfied: ${waitId}` : "✓ Wait satisfied"];
    }
    case "workflow.completed":
      return ["✓ Workflow completed"];
    case "workflow.failed": {
      const failure = event.payload.failure;
      const message =
        typeof failure === "object" &&
        failure !== null &&
        "message" in failure &&
        typeof failure.message === "string"
          ? `: ${failure.message}`
          : "";
      return [`✗ Workflow failed${message}`];
    }
    default:
      return undefined;
  }
}

function readEventType(event: Event): string {
  return event.type;
}
