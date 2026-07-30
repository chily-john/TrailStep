import { join } from "node:path";

import { resolveStepArtifactPaths } from "../../../runtime/artifacts/step-artifacts.js";

export interface WorkingAgentFiles {
  readonly stepDir: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly usageFile: string;
}

export function resolveStepAgentFiles(options: {
  readonly runDir: string;
  readonly stepId: string;
  readonly stepIndex: number;
}): WorkingAgentFiles {
  const artifactPaths = resolveStepArtifactPaths(options);
  return {
    stepDir: artifactPaths.stepDir,
    promptFile: join(artifactPaths.stepDir, "prompt.md"),
    outputFile: artifactPaths.outputFile,
    usageFile: artifactPaths.usageFile,
  };
}
