import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createRunDirectory } from "../artifacts/run-storage.js";
import { createRunContext } from "./create-run-context.js";

describe("createRunContext", () => {
  it("creates two RunContext instances that share durable state for the same run directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-run-context-"));
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
});
