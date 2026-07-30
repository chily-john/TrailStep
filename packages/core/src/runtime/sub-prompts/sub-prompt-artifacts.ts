import { join, relative } from "node:path";

export function resolveSubPromptArtifactPaths(options: {
  readonly runDir: string;
  readonly stepDir: string;
  readonly ordinal: number;
  readonly fingerprint: string;
}): {
  readonly subPromptDir: string;
  readonly promptFile: string;
  readonly outputFile: string;
  readonly usageFile: string;
  readonly runRelative: {
    readonly subPromptDir: string;
    readonly promptFile: string;
    readonly outputFile: string;
  };
} {
  const artifactSubPromptId = `${String(options.ordinal).padStart(4, "0")}-${options.fingerprint.slice(0, 12)}`;
  const subPromptDir = join(options.stepDir, "subPrompts", artifactSubPromptId);
  const promptFile = join(subPromptDir, "prompt.txt");
  const outputFile = join(subPromptDir, "output.json");
  const usageFile = join(subPromptDir, "usage.json");

  return {
    subPromptDir,
    promptFile,
    outputFile,
    usageFile,
    runRelative: {
      subPromptDir: toRunRelativePath(options.runDir, subPromptDir),
      promptFile: toRunRelativePath(options.runDir, promptFile),
      outputFile: toRunRelativePath(options.runDir, outputFile),
    },
  };
}

function toRunRelativePath(runDir: string, path: string): string {
  return relative(runDir, path).replaceAll("\\", "/");
}
