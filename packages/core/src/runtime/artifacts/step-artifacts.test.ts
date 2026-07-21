import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveStepArtifactPaths } from "./step-artifacts.js";

describe("resolveStepArtifactPaths", () => {
  it("builds zero-padded run-relative step artifact directories with sanitized step ids", async () => {
    const paths = resolveStepArtifactPaths({
      runDir: join(".stepkit", "runs", "ordered-artifacts-run"),
      stepId: "Review & Approve/Plan?",
      stepIndex: 2,
    });

    expect(paths.artifactStepId).toBe("0002-review-approve-plan");
    expect(paths.runRelativeStepDir).toBe("steps/0002-review-approve-plan");
    expect(paths.runRelativeSessionDescriptionFile).toBe(
      "steps/0002-review-approve-plan/session-description.md",
    );
    expect(paths.stepDir).toBe(
      join(".stepkit", "runs", "ordered-artifacts-run", "steps", "0002-review-approve-plan"),
    );
    expect(paths.outputFile).toBe(join(paths.stepDir, "output.json"));
    expect(paths.usageFile).toBe(join(paths.stepDir, "usage.json"));
    expect(paths.interactiveFile).toBe(join(paths.stepDir, "interactive.json"));
    expect(paths.sessionDescriptionFile).toBe(join(paths.stepDir, "session-description.md"));
  });
});
