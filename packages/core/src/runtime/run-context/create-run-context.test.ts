import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createRunDirectory } from "../artifacts/run-storage.js";
import { createRunContext } from "./create-run-context.js";

describe("createRunContext", () => {
  it("creates two RunContext instances that share durable state for the same run directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-context-"));
    const { runId, runDir } = await createRunDirectory({ cwd, runName: "shared-state" });

    const first = createRunContext({ runId, runName: "shared-state", runDir });
    const second = createRunContext({ runId, runName: "shared-state", runDir });

    expect(first.id).toBe(runId);
    expect(first.name).toBe("shared-state");
    expect(first.path).toBe(runDir);

    await first.state.set("count", { value: 1 });

    await expect(second.state.get("count")).resolves.toEqual({ value: 1 });
    await expect(second.state.get("missing")).resolves.toBeUndefined();
  });

  it("does not lose updates from concurrent set calls on the same instance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-context-"));
    const { runId, runDir } = await createRunDirectory({ cwd, runName: "concurrent-state" });

    const context = createRunContext({ runId, runName: "concurrent-state", runDir });

    await Promise.all([
      context.state.set("a", 1),
      context.state.set("b", 2),
      context.state.set("c", 3),
    ]);

    await expect(context.state.get("a")).resolves.toBe(1);
    await expect(context.state.get("b")).resolves.toBe(2);
    await expect(context.state.get("c")).resolves.toBe(3);

    const reloaded = createRunContext({ runId, runName: "concurrent-state", runDir });
    await expect(reloaded.state.get("a")).resolves.toBe(1);
    await expect(reloaded.state.get("b")).resolves.toBe(2);
    await expect(reloaded.state.get("c")).resolves.toBe(3);
  });
});
