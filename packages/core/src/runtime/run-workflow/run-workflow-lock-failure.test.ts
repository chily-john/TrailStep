import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { done } from "../../authoring/authoring.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";

const failingRmPaths = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      if (typeof path === "string" && failingRmPaths.has(path)) {
        throw new Error("simulated rollback removal failure");
      }
      return options === undefined ? await actual.rm(path) : await actual.rm(path, options);
    },
  };
});

vi.mock("../run-lock/run-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-lock/run-lock.js")>();
  return {
    ...actual,
    acquireRunLock: async (options: Parameters<typeof actual.acquireRunLock>[0]) => {
      void options;
      throw new Error("simulated lock write failure");
    },
  };
});

import { runWorkflow } from "./run-workflow.js";

describe("runWorkflow lock acquisition rollback", () => {
  it("removes a freshly created event-less run directory when the lock cannot be acquired", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-lock-failure-"));
    const workflow: Workflow<{ value: number }, { ok: boolean }> = {
      id: "lock-failure-workflow",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start() {
        return done({ ok: true });
      },
    };

    await expect(
      runWorkflow({
        workflow,
        input: { value: 1 },
        runName: "lock-failure-run",
        cwd,
      }),
    ).rejects.toThrow("simulated lock write failure");

    await expect(stat(join(cwd, ".trailstep", "runs", "lock-failure-run"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(join(cwd, ".trailstep", "runs"))).resolves.toEqual([]);
  });

  it("reports a failed rollback removal on stderr without masking the original error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-runtime-lock-failure-"));
    const runDir = join(cwd, ".trailstep", "runs", "rollback-phantom-run");
    const workflow: Workflow<{ value: number }, { ok: boolean }> = {
      id: "lock-failure-workflow",
      inputShape: { value: "number" },
      outputShape: { ok: "boolean" },
      start() {
        return done({ ok: true });
      },
    };
    failingRmPaths.add(runDir);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await expect(
        runWorkflow({
          workflow,
          input: { value: 1 },
          runName: "rollback-phantom-run",
          cwd,
        }),
      ).rejects.toThrow("simulated lock write failure");
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("could not remove event-less run directory"),
      );
    } finally {
      failingRmPaths.delete(runDir);
      stderr.mockRestore();
    }
    // The phantom directory stays visible; the original setup error wins.
    await expect(stat(runDir)).resolves.toBeDefined();
  });
});
