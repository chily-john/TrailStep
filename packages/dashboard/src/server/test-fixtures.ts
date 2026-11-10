import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it as base } from "vitest";

export const it = base.extend<{ cwd: string }>({
  cwd: async ({ task }, use) => {
    const cwd = await mkdtemp(join(tmpdir(), `trailstep-dashboard-${task.id}-`));
    try {
      await use(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
});
