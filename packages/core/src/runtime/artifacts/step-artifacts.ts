import { join } from "node:path";

export interface WaitArtifactPaths {
  readonly requestFile: string;
  readonly answerFile: string;
}

export interface ResolvedWaitArtifactPaths {
  readonly waitDir: string;
  readonly requestFile: string;
  readonly answerFile: string;
  readonly runRelative: WaitArtifactPaths;
}

export interface StepArtifactPaths {
  readonly artifactStepId: string;
  readonly stepDir: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly usageFile: string;
  readonly interactiveFile: string;
  readonly sessionDescriptionFile: string;
  readonly runRelativeStepDir: string;
  readonly runRelativeSessionDescriptionFile: string;
}

export function resolveStepArtifactPaths(options: {
  readonly runDir: string;
  readonly stepId: string;
  readonly stepIndex: number;
}): StepArtifactPaths {
  const artifactStepId = `${String(options.stepIndex).padStart(4, "0")}-${sanitizeStepId(
    options.stepId,
  )}`;
  const runRelativeStepDir = `steps/${artifactStepId}`;
  const runRelativeSessionDescriptionFile = `${runRelativeStepDir}/session-description.md`;
  const stepDir = join(options.runDir, "steps", artifactStepId);

  return {
    artifactStepId,
    stepDir,
    promptFile: join(stepDir, "prompt.txt"),
    outputFile: join(stepDir, "output.json"),
    usageFile: join(stepDir, "usage.json"),
    interactiveFile: join(stepDir, "interactive.json"),
    sessionDescriptionFile: join(stepDir, "session-description.md"),
    runRelativeStepDir,
    runRelativeSessionDescriptionFile,
  };
}

export function resolveWaitArtifactPaths(options: {
  readonly runDir: string;
  readonly stepArtifactId: string;
  readonly waitId: string;
}): ResolvedWaitArtifactPaths {
  const runRelativeWaitDir = `steps/${options.stepArtifactId}/waits/${options.waitId}`;
  const waitDir = join(options.runDir, "steps", options.stepArtifactId, "waits", options.waitId);

  return {
    waitDir,
    requestFile: join(waitDir, "request.json"),
    answerFile: join(waitDir, "answer.json"),
    runRelative: {
      requestFile: `${runRelativeWaitDir}/request.json`,
      answerFile: `${runRelativeWaitDir}/answer.json`,
    },
  };
}

function sanitizeStepId(stepId: string): string {
  return (
    stepId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "step"
  );
}
