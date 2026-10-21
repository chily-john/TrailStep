import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { trst_watch } from "../src/tools/trst_watch.js";

// Focused tests for the trst_watch tool. Every artifact (run dir, events.jsonl,
// cursor dir) lives in a per-test tmp directory — never the repo .trailstep/mcp.

interface TmpSandbox {
  readonly root: string;
  readonly runDir: string;
  readonly cursorDir: string;
  readonly eventsFile: string;
}

const sandboxes: TmpSandbox[] = [];

function createSandbox(runId = "run-1"): TmpSandbox {
  const root = mkdtempSync(path.join(tmpdir(), "trst-watch-test-"));
  const runDir = path.join(root, "runs", runId);
  const cursorDir = path.join(root, "mcp-cursor");
  mkdirSync(runDir, { recursive: true });
  const sandbox: TmpSandbox = {
    root,
    runDir,
    cursorDir,
    eventsFile: path.join(runDir, "events.jsonl"),
  };
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const sandbox = sandboxes.pop();
    if (sandbox) {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
});

function eventLine(type: string, index: number): string {
  return JSON.stringify({
    id: `evt-${index}`,
    runId: "run-1",
    workflowId: "wf",
    type,
    timestamp: new Date(0).toISOString(),
    schemaVersion: "v0",
    payload: {},
  });
}

function appendLines(sandbox: TmpSandbox, lines: readonly string[]): void {
  writeFileSync(sandbox.eventsFile, `${lines.join("\n")}\n`, "utf8");
}

function appendMoreLines(sandbox: TmpSandbox, lines: readonly string[]): void {
  writeFileSync(sandbox.eventsFile, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

function quickOptions(sandbox: TmpSandbox, timeoutMs = 250) {
  return {
    runDir: sandbox.runDir,
    cursorDir: sandbox.cursorDir,
    timeoutMs,
    pollIntervalMs: 5,
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("trst_watch", () => {
  it("returns header + complete event lines and leaves partial trailing lines for later", async () => {
    const sandbox = createSandbox();
    const lines = [eventLine("workflow.started", 1), eventLine("step.started", 2)];
    writeFileSync(
      sandbox.eventsFile,
      `${lines.join("\n")}\n${eventLine("step.completed", 3)}`,
      "utf8",
    );

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    expect(result.header).toContain("watch:run-1");
    expect(result.state).toBe("in-progress");
    expect(result.lines).toEqual(lines);
    expect(result.truncated).toBe(false);
    expect(result.cursor).toBe(byteLength(`${lines.join("\n")}\n`));
  });

  it("persists the cursor atomically as {runId,cursor} under the cursor dir", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1)]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    const cursorFile = path.join(sandbox.cursorDir, "run-1.json");
    const parsed = JSON.parse(readFileSync(cursorFile, "utf8"));
    expect(parsed).toEqual({ runId: "run-1", cursor: result.cursor });
    // Atomic write: no leftover tmp files after rename.
    expect(readdirSync(sandbox.cursorDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reconnect reuses the persisted cursor and only returns new events", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);

    const first = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(first.lines).toHaveLength(2);

    appendMoreLines(sandbox, [eventLine("step.completed", 3)]);
    const reconnect = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(reconnect.lines).toHaveLength(1);
    expect(reconnect.cursor).toBeGreaterThan(first.cursor);
  });

  it("an explicit cursor param overrides the persisted cursor", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);

    await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    const fromStart = await trst_watch({ runId: "run-1", cursor: 0 }, quickOptions(sandbox));
    expect(fromStart.lines).toHaveLength(2);
  });

  it("caps emitted lines by verbosity within 50-200 and keeps the rest for the next call", async () => {
    const sandbox = createSandbox();
    const all = Array.from({ length: 60 }, (_, i) => eventLine("step.progress", i + 1));
    appendLines(sandbox, all);

    const brief = await trst_watch({ runId: "run-1", verbosity: "brief" }, quickOptions(sandbox));
    expect(brief.lines).toHaveLength(50);
    expect(brief.truncated).toBe(true);
    expect(brief.cursor).toBe(byteLength(`${all.slice(0, 50).join("\n")}\n`));

    const rest = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(rest.lines).toHaveLength(10);
    expect(rest.truncated).toBe(false);
  });

  it("long-poll waits out its real budget when there is nothing new", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1)]);
    const first = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(first.lines).toHaveLength(1);

    const startedAt = Date.now();
    const idle = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 250));
    const elapsed = Date.now() - startedAt;

    expect(idle.lines).toEqual([]);
    expect(idle.cursor).toBe(first.cursor);
    // Real polling, not an instant fake return and not one fixed sleep of a
    // 20-30 s constant: the budget was actually waited out.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000);
  });

  it("long-poll returns early once new events appear mid-poll", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1)]);
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    setTimeout(() => {
      appendMoreLines(sandbox, [eventLine("wait.started", 2)]);
    }, 30);

    const startedAt = Date.now();
    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 3000));
    const elapsed = Date.now() - startedAt;

    expect(result.lines).toHaveLength(1);
    expect(result.state).toBe("in-progress");
    expect(elapsed).toBeLessThan(1500);
  });

  it("classifies terminal runs from the full stream, not just the new delta", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("workflow.completed", 2)]);

    const first = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(first.state).toBe("terminal");

    const reconnect = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(reconnect.state).toBe("terminal");
    expect(reconnect.lines).toEqual([]);
    expect(reconnect.cursor).toBe(first.cursor);
  });

  it("reports started state for an empty events file", async () => {
    const sandbox = createSandbox();
    writeFileSync(sandbox.eventsFile, "", "utf8");

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(result.state).toBe("started");
    expect(result.lines).toEqual([]);
    expect(result.cursor).toBe(0);
  });

  it("keeps the cursor file intact across overlapping watch calls in one process", async () => {
    const sandbox = createSandbox();
    const lines = [eventLine("workflow.started", 1), eventLine("step.started", 2)];
    appendLines(sandbox, lines);

    // Overlapping polls share pid + cursor file; each must use its own random
    // tmp path so concurrent tmp+rename writes cannot corrupt or lose each
    // other's cursor.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        trst_watch({ runId: "run-1", cursor: 0 }, quickOptions(sandbox)),
      ),
    );

    const expectedCursor = byteLength(`${lines.join("\n")}\n`);
    for (const result of results) {
      expect(result.lines).toEqual(lines);
      expect(result.cursor).toBe(expectedCursor);
    }

    const cursorFile = path.join(sandbox.cursorDir, "run-1.json");
    const parsed = JSON.parse(readFileSync(cursorFile, "utf8"));
    expect(parsed).toEqual({ runId: "run-1", cursor: expectedCursor });
    expect(readdirSync(sandbox.cursorDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("resolves runs under TRAILSTEP_RUNS_ROOT via resolveRunsRoot (cwd-anchored, like the CLI)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "trst-watch-env-"));
    const runDir = path.join(root, "elsewhere", "runs", "run-1");
    const cursorDir = path.join(root, "mcp-cursor");
    mkdirSync(runDir, { recursive: true });
    const eventsFile = path.join(runDir, "events.jsonl");
    writeFileSync(eventsFile, `${eventLine("workflow.started", 1)}\n`, "utf8");
    sandboxes.push({ root, runDir, cursorDir, eventsFile });

    const base = { cwd: root, cursorDir, timeoutMs: 250, pollIntervalMs: 5 };

    // Empty override falls back to <cwd>/.trailstep/runs → the run is not found.
    await expect(
      trst_watch({ runId: "run-1" }, { ...base, env: { TRAILSTEP_RUNS_ROOT: "" } }),
    ).rejects.toThrow(/run not found/u);

    // A relative override is anchored to cwd, exactly like the CLI's resolveRunsRoot.
    const result = await trst_watch(
      { runId: "run-1" },
      { ...base, env: { TRAILSTEP_RUNS_ROOT: path.join("elsewhere", "runs") } },
    );
    expect(result.runId).toBe("run-1");
    expect(result.state).toBe("in-progress");
    expect(result.lines).toHaveLength(1);
  });

  it("fails clearly for an unknown run and for missing runId", async () => {
    const sandbox = createSandbox();
    await expect(trst_watch({ runId: "nope" }, quickOptions(sandbox))).rejects.toThrow(
      /run not found/u,
    );
    await expect(trst_watch({}, quickOptions(sandbox))).rejects.toThrow(/runId/u);
  });
});
