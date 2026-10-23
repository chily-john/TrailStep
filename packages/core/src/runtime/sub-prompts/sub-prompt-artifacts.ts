import { join, relative } from "node:path";

import type { WorkingAgentFiles } from "../../agent-execution/working-agent/artifacts/resolve-step-agent-files.js";

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

/**
 * Resolves the full working-agent artifact file set for a sub-prompt run: the
 * prompt/output/usage artifacts plus the working/repair/attempts/stderr capture
 * files, all rooted in the sub-prompt artifact directory.
 */
export function resolveSubPromptAgentFiles(options: {
  readonly runDir: string;
  readonly stepDir: string;
  readonly ordinal: number;
  readonly fingerprint: string;
}): WorkingAgentFiles {
  const artifactPaths = resolveSubPromptArtifactPaths(options);
  return {
    stepDir: artifactPaths.subPromptDir,
    promptFile: artifactPaths.promptFile,
    outputFile: artifactPaths.outputFile,
    usageFile: artifactPaths.usageFile,
    workFile: join(artifactPaths.subPromptDir, "work.txt"),
    repairPromptFile: join(artifactPaths.subPromptDir, "repair-prompt.md"),
    attemptsFile: join(artifactPaths.subPromptDir, "attempts.json"),
    stderrFile: join(artifactPaths.subPromptDir, "stderr.txt"),
  };
}
