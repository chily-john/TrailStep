import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findActiveInteractiveSessions } from "./active-interactive-sessions.js";

describe("active interactive sessions", () => {
  it("does not scan active markers under staging infrastructure", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-active-interactive-tests", task.id);
    const runsDir = join(cwd, ".trailstep", "runs");
    await writeInteractiveSession(runsDir, "real-run");
    await writeInteractiveSession(runsDir, join(".staging", "phantom-run"));

    const sessions = await findActiveInteractiveSessions(cwd);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.label).toContain("run real-run");
  });
});

async function writeInteractiveSession(runsDir: string, runId: string): Promise<void> {
  const interactiveFile = join(runsDir, runId, "steps", "0001-step", "interactive.json");
  await mkdir(join(runsDir, runId, "steps", "0001-step"), { recursive: true });
  await writeFile(
    interactiveFile,
    `${JSON.stringify({
      status: "active",
      runDir: join(runsDir, runId),
      stepId: "step",
      artifactStepId: "0001-step",
      outputMode: "interactive",
    })}\n`,
    "utf8",
  );
}
