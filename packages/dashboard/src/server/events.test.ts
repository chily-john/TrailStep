import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDashboardRunEvents } from "./events";

describe("dashboard event helpers", () => {
  it("maps resume_target_not_found to an empty event list", async ({ task }) => {
    const runDir = join(process.cwd(), ".tmp", task.id, ".trailstep", "runs", "missing-events");
    await mkdir(runDir, { recursive: true });

    await expect(readDashboardRunEvents(runDir)).resolves.toEqual([]);
  });
});
