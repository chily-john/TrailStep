import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunDirectory, type RunState } from "../artifacts/run-storage.js";
import {
  createQueuedGlobalState,
  createQueuedRunState,
  createRunContext,
} from "./create-run-context.js";

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

describe("queued state persistence failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("run-state: a failed write rejects its caller, is reported, and the next write succeeds", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const writes: RunState[] = [];
    let failNextWrite = true;
    const state = createQueuedRunState({
      read: async () => ({}),
      write: async (next) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("disk full");
        }
        writes.push(next);
      },
    });

    // (a)+(d) the failure surfaces to the caller that triggered it, and (b) it
    // is reported instead of being silently dropped.
    await expect(state.set("a", 1)).rejects.toThrow("disk full");
    const firstReports = stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("persistence failed"));
    expect(firstReports.join("")).toContain("run state persistence failed: disk full");

    // (c) the queue keeps working, and the successful write must NOT inherit
    // the earlier failure. The value the failed write left in the cache is
    // flushed by this write, so it is not silently dropped either.
    await expect(state.set("b", 2)).resolves.toBeUndefined();
    expect(writes).toEqual([{ a: 1, b: 2 }]);

    // Exactly one report: the failure surfaced once, to its own caller.
    expect(
      stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("persistence failed")),
    ).toHaveLength(1);
  });

  it("global-state: a failed mutation rejects its caller, is reported, and later mutations work", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const writes: RunState[] = [];
    let failNextWrite = true;
    const globalState = createQueuedGlobalState({
      read: async () => ({}),
      write: async (next) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("io error");
        }
        writes.push(next);
      },
    });

    await expect(globalState.set("a", 1)).rejects.toThrow("io error");
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "global state persistence failed: io error",
    );

    // The queue is neither dead nor poisoned: the next set succeeds, and an
    // update after it resolves with its own value instead of the old failure.
    await expect(globalState.set("b", 2)).resolves.toBeUndefined();
    await expect(
      globalState.update<number>("count", (current) =>
        typeof current === "number" ? current + 1 : 1,
      ),
    ).resolves.toBe(1);
    expect(writes.at(-1)).toEqual({ a: 1, b: 2, count: 1 });

    expect(
      stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("persistence failed")),
    ).toHaveLength(1);
  });

  it("run-state: a failed initial read does not poison later operations", async () => {
    let failNextRead = true;
    const state = createQueuedRunState({
      read: async () => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("read exploded");
        }
        return { ready: true };
      },
      write: async () => {},
    });

    await expect(state.get("ready")).rejects.toThrow("read exploded");
    // The rejected load is not cached: the next access retries and succeeds.
    await expect(state.get("ready")).resolves.toBe(true);
    await expect(state.set("value", 7)).resolves.toBeUndefined();
  });

  it("global-state: a failed initial read does not poison later operations", async () => {
    let failNextRead = true;
    const globalState = createQueuedGlobalState({
      read: async () => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error("read exploded");
        }
        return { ready: true };
      },
      write: async () => {},
    });

    await expect(globalState.get("ready")).rejects.toThrow("read exploded");
    await expect(globalState.get("ready")).resolves.toBe(true);
    await expect(globalState.set("value", 7)).resolves.toBeUndefined();
  });
});
