import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveSubPromptAgentFiles,
  resolveSubPromptArtifactPaths,
} from "./sub-prompt-artifacts.js";

describe("resolveSubPromptArtifactPaths", () => {
  it("returns stable sub-prompt artifact paths relative to the run using forward slashes", () => {
    const runDir = join("tmp", "runs", "example-run");
    const stepDir = join(runDir, "steps", "0001-orchestrate");

    const paths = resolveSubPromptArtifactPaths({
      runDir,
      stepDir,
      ordinal: 1,
      fingerprint: "abcdef1234567890",
    });

    expect(paths.promptFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "prompt.txt"));
    expect(paths.outputFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "output.json"));
    expect(paths.usageFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "usage.json"));
    expect(paths.runRelative).toEqual({
      subPromptDir: "steps/0001-orchestrate/subPrompts/0001-abcdef123456",
      promptFile: "steps/0001-orchestrate/subPrompts/0001-abcdef123456/prompt.txt",
      outputFile: "steps/0001-orchestrate/subPrompts/0001-abcdef123456/output.json",
    });
  });
});

describe("resolveSubPromptAgentFiles", () => {
  it("returns the full working-agent artifact file set rooted in the sub-prompt dir", () => {
    const runDir = join("tmp", "runs", "example-run");
    const stepDir = join(runDir, "steps", "0001-orchestrate");

    const files = resolveSubPromptAgentFiles({
      runDir,
      stepDir,
      ordinal: 1,
      fingerprint: "abcdef1234567890",
    });

    expect(files.stepDir).toBe(join(stepDir, "subPrompts", "0001-abcdef123456"));
    expect(files.promptFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "prompt.txt"));
    expect(files.outputFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "output.json"));
    expect(files.usageFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "usage.json"));
    expect(files.workFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "work.txt"));
    expect(files.repairPromptFile).toBe(
      join(stepDir, "subPrompts", "0001-abcdef123456", "repair-prompt.md"),
    );
    expect(files.attemptsFile).toBe(
      join(stepDir, "subPrompts", "0001-abcdef123456", "attempts.json"),
    );
    expect(files.stderrFile).toBe(join(stepDir, "subPrompts", "0001-abcdef123456", "stderr.txt"));
  });
});
