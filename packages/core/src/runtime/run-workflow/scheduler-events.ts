import { resolveStepArtifactPaths } from "../artifacts/step-artifacts.js";
import type { Event } from "./run-workflow.types.js";
import type { BranchState } from "./scheduler-types.js";

export function decorateBranchEvent(
  event: Event,
  trackId: string,
  branch: BranchState,
  decorateWaits: boolean,
): Event {
  const isStepEvent = event.type === "step.started" || event.type === "step.completed";
  const isWaitEvent =
    event.type === "wait.started" ||
    event.type === "wait.satisfied" ||
    event.type === "wait.failed";
  if ((!isStepEvent && !isWaitEvent) || (isWaitEvent && !decorateWaits)) {
    return event;
  }

  const stepArtifactPaths =
    event.stepId === undefined || branch.latestStepIndex < 1
      ? undefined
      : resolveStepArtifactPaths({
          runDir: "",
          stepId: event.stepId,
          stepIndex: branch.latestStepIndex,
        });

  return {
    ...event,
    payload: {
      ...event.payload,
      trackId,
      branchId: branch.branchId,
      ...(branch.requestedBranchId === undefined
        ? {}
        : { requestedBranchId: branch.requestedBranchId }),
      ...(stepArtifactPaths === undefined
        ? {}
        : {
            stepIndex: branch.latestStepIndex,
            stepArtifactId: stepArtifactPaths.artifactStepId,
            stepArtifactPath: stepArtifactPaths.runRelativeStepDir,
          }),
    },
  };
}
