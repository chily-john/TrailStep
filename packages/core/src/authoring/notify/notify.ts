import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import { createEvent } from "../../runtime/events/create-run-event.js";
import { runContextStorage } from "../../runtime/run-context/run-context-storage.js";

export interface NotifyArtifact {
  readonly path: string;
  readonly mediaType?: string;
  readonly data?: PlainObject;
}

export interface NotifyApi {
  progress(message: string, data?: PlainObject): Promise<void>;
  warning(message: string, data?: PlainObject): Promise<void>;
  artifact(name: string, artifact: NotifyArtifact): Promise<void>;
}

export const notify: NotifyApi = {
  async progress(message, data) {
    await emitNotification("step.progress", { message, ...(data === undefined ? {} : { data }) });
  },
  async warning(message, data) {
    await emitNotification("step.warning", { message, ...(data === undefined ? {} : { data }) });
  },
  async artifact(name, artifact) {
    await emitNotification("step.artifact", {
      name,
      path: artifact.path,
      ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
      ...(artifact.data === undefined ? {} : { data: artifact.data }),
    });
  },
};

async function emitNotification(
  type: "step.progress" | "step.warning" | "step.artifact",
  payload: PlainObject,
): Promise<void> {
  const runContext = runContextStorage.getStore();
  if (!runContext?.workflowId || !runContext.emit) {
    throw new Error("notify.* called outside an active TrailStep run.");
  }

  await runContext.emit(
    createEvent({
      runId: runContext.id,
      workflowId: runContext.workflowId,
      ...(runContext.currentStep === undefined ? {} : { stepId: runContext.currentStep.id }),
      type,
      payload,
    }),
  );
}
