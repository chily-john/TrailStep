import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  type TrstWatchParams,
  type TrstWatchProgressEvent,
  trst_watch,
} from "../src/tools/trst_watch.js";

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

function eventLine(
  type: string,
  index: number,
  payload: Record<string, unknown> = {},
  stepId?: string,
): string {
  return JSON.stringify({
    id: `evt-${index}`,
    runId: "run-1",
    workflowId: "wf",
    ...(stepId === undefined ? {} : { stepId }),
    type,
    timestamp: new Date(0).toISOString(),
    schemaVersion: "v0",
    payload,
  });
}

function waitLine(
  index: number,
  options: {
    readonly waitId: string;
    readonly question?: string;
    readonly branchId?: string;
    readonly answerFile?: string;
    readonly stepId?: string;
  },
): string {
  return eventLine(
    "wait.started",
    index,
    {
      waitId: options.waitId,
      ...(options.question === undefined ? {} : { message: options.question }),
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      ...(options.answerFile === undefined
        ? {}
        : { artifactPaths: { answerFile: options.answerFile } }),
    },
    options.stepId ?? "step-1",
  );
}

function appendLines(sandbox: TmpSandbox, lines: readonly string[]): void {
  writeFileSync(sandbox.eventsFile, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Writes a run lock held by a LIVE pid (this test process). Without one, a trail with no
 * terminal event is classified `crashed`: nothing is driving the run. Mirroring reality (a
 * running continue holds the lock) is what keeps an in-progress fixture in-progress.
 */
function writeLiveLock(sandbox: TmpSandbox): void {
  writeFileSync(
    path.join(sandbox.runDir, "run.lock"),
    JSON.stringify({
      schemaVersion: 1,
      runId: path.basename(sandbox.runDir),
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      lastHeartbeatAt: new Date(0).toISOString(),
      nonce: "test-live-lock",
    }),
    "utf8",
  );
}

/** Writes a run lock whose holder pid does not exist: a dead run's leftovers. */
function writeDeadLock(sandbox: TmpSandbox): void {
  writeFileSync(
    path.join(sandbox.runDir, "run.lock"),
    JSON.stringify({
      schemaVersion: 1,
      runId: path.basename(sandbox.runDir),
      pid: 2_147_483_646,
      startedAt: new Date(0).toISOString(),
      lastHeartbeatAt: new Date(0).toISOString(),
      nonce: "test-dead-lock",
    }),
    "utf8",
  );
}

function appendMoreLines(sandbox: TmpSandbox, lines: readonly string[]): void {
  writeFileSync(sandbox.eventsFile, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

function quickOptions(sandbox: TmpSandbox, maxWaitMs = 250) {
  return {
    runDir: sandbox.runDir,
    cursorDir: sandbox.cursorDir,
    maxWaitMs,
    pollIntervalMs: 5,
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("trst_watch attention contract", () => {
  it("returns immediately for a parked wait with every pending wait and an advanced cursor", async () => {
    const sandbox = createSandbox();
    const lines = [
      eventLine("workflow.started", 1),
      waitLine(2, {
        waitId: "approval",
        question: "Approve the release?",
        answerFile: "answers/approval.json",
      }),
    ];
    appendLines(sandbox, lines);

    const startedAt = Date.now();
    const result = await trst_watch({ runId: "run-1", maxWaitMs: 5000 }, quickOptions(sandbox));
    const elapsed = Date.now() - startedAt;

    // A parked run must never burn the poll budget.
    expect(elapsed).toBeLessThan(2000);
    expect(result.state).toBe("waiting");
    expect(result.lines).toEqual([]);
    expect(result.waits).toEqual([
      {
        waitId: "approval",
        branchId: "root",
        stepId: "step-1",
        question: "Approve the release?",
        answerFile: "answers/approval.json",
      },
    ]);
    expect(result.cursor).toBe(byteLength(`${lines.join("\n")}\n`));

    const persisted = JSON.parse(
      readFileSync(path.join(sandbox.cursorDir, "run-1.json"), "utf8"),
    ) as { cursor?: unknown };
    expect(persisted.cursor).toBe(result.cursor);
  });

  it("keeps same-id waits on different branches distinct and drops the resolved branch", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      waitLine(2, {
        waitId: "approval",
        branchId: "a",
        question: "Branch A?",
        answerFile: "answers/a.json",
      }),
      waitLine(3, {
        waitId: "approval",
        branchId: "b",
        question: "Branch B?",
        answerFile: "answers/b.json",
      }),
      eventLine(
        "wait.satisfied",
        4,
        { waitId: "approval", branchId: "b", artifactPaths: { answerFile: "answers/b.json" } },
        "step-1",
      ),
    ]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    expect(result.state).toBe("waiting");
    expect(result.waits).toEqual([
      {
        waitId: "approval",
        branchId: "a",
        stepId: "step-1",
        question: "Branch A?",
        answerFile: "answers/a.json",
      },
    ]);
  });

  it("returns terminal output verbatim, repeatably, including when the events predate the cursor", async () => {
    const sandbox = createSandbox();
    const lines = [
      eventLine("workflow.started", 1),
      eventLine("workflow.completed", 2, { output: { answer: 42, nested: { ok: true } } }),
    ];
    appendLines(sandbox, lines);
    const endCursor = byteLength(`${lines.join("\n")}\n`);

    const first = await trst_watch({ runId: "run-1", maxWaitMs: 5000 }, quickOptions(sandbox));
    expect(first.state).toBe("terminal");
    expect(first.output).toEqual({ answer: 42, nested: { ok: true } });
    expect(first.cursor).toBe(endCursor);

    const repeat = await trst_watch({ runId: "run-1", maxWaitMs: 5000 }, quickOptions(sandbox));
    expect(repeat.state).toBe("terminal");
    expect(repeat.output).toEqual({ answer: 42, nested: { ok: true } });
    expect(repeat.cursor).toBe(first.cursor);

    // Explicit cursor at the end: the terminal event predates it, but re-attaching
    // to a finished run must still return the final output.
    const reattached = await trst_watch(
      { runId: "run-1", cursor: endCursor, maxWaitMs: 5000 },
      quickOptions(sandbox),
    );
    expect(reattached.state).toBe("terminal");
    expect(reattached.output).toEqual({ answer: 42, nested: { ok: true } });
  });

  it("reports crashed with a reason when there is no terminal event and no live lock", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    expect(result.state).toBe("crashed");
    expect(result.crash).toEqual({ reason: "no terminal event and no live lock" });
    expect(result.waits).toBeUndefined();
    expect(result.output).toBeUndefined();
  });

  it("maxWaitMs 0 is an immediate single-shot snapshot with no sleeping", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);
    writeLiveLock(sandbox);
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    const startedAt = Date.now();
    const result = await trst_watch({ runId: "run-1", maxWaitMs: 0 }, quickOptions(sandbox, 5000));
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
    expect(result.state).toBe("in-progress");
    expect(result.requestedWaitMs).toBe(0);
    expect(result.effectiveWaitMs).toBe(0);
    expect(result.progress?.newEvents).toBe(0);
  });

  it("clamps the effective budget by capability and honours a smaller request", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      eventLine("workflow.completed", 2, { output: { done: true } }),
    ]);
    const base = { runDir: sandbox.runDir, cursorDir: sandbox.cursorDir, pollIntervalMs: 5 };

    // Default request (300000) with a progressless caller is clamped to 25 s.
    const defaults = await trst_watch({ runId: "run-1" }, base);
    expect(defaults.state).toBe("terminal");
    expect(defaults.requestedWaitMs).toBe(300_000);
    expect(defaults.effectiveWaitMs).toBe(25_000);

    // A progress-capable caller may use the full requested budget.
    const capable = await trst_watch({ runId: "run-1" }, { ...base, progressCapable: true });
    expect(capable.requestedWaitMs).toBe(300_000);
    expect(capable.effectiveWaitMs).toBe(300_000);

    // A smaller explicit request wins over both ceilings.
    const shortProgressless = await trst_watch({ runId: "run-1", maxWaitMs: 5000 }, base);
    expect(shortProgressless.requestedWaitMs).toBe(5000);
    expect(shortProgressless.effectiveWaitMs).toBe(5000);

    const shortCapable = await trst_watch(
      { runId: "run-1", maxWaitMs: 5000 },
      { ...base, progressCapable: true },
    );
    expect(shortCapable.requestedWaitMs).toBe(5000);
    expect(shortCapable.effectiveWaitMs).toBe(5000);
  });

  it("full verbosity keeps raw lines with the 200 cap and cursor-through-emitted-lines", async () => {
    const sandbox = createSandbox();
    const all = Array.from({ length: 205 }, (_, i) => eventLine("step.progress", i + 1));
    appendLines(sandbox, all);
    writeLiveLock(sandbox);

    const first = await trst_watch(
      { runId: "run-1", verbosity: "full" },
      quickOptions(sandbox, 5000),
    );
    expect(first.lines).toHaveLength(200);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe(byteLength(`${all.slice(0, 200).join("\n")}\n`));

    const rest = await trst_watch(
      { runId: "run-1", verbosity: "full" },
      quickOptions(sandbox, 5000),
    );
    expect(rest.lines).toHaveLength(5);
    expect(rest.truncated).toBe(false);
    expect(rest.progress?.newEvents).toBe(5);
    expect(rest.cursor).toBe(byteLength(`${all.join("\n")}\n`));
  });

  it("compact mode emits no lines and advances the cursor through every consumed event", async () => {
    const sandbox = createSandbox();
    const all = Array.from({ length: 60 }, (_, i) => eventLine("step.progress", i + 1));
    appendLines(sandbox, all);
    writeLiveLock(sandbox);

    const first = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));
    expect(first.lines).toEqual([]);
    expect(first.truncated).toBe(false);
    expect(first.progress?.newEvents).toBe(60);
    expect(first.cursor).toBe(byteLength(`${all.join("\n")}\n`));

    const again = await trst_watch({ runId: "run-1", maxWaitMs: 0 }, quickOptions(sandbox, 5000));
    expect(again.lines).toEqual([]);
    expect(again.progress?.newEvents).toBe(0);
    expect(again.cursor).toBe(first.cursor);
  });

  it("classifies a pending wait as waiting even while the lock is live", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      waitLine(2, { waitId: "checkpoint", question: "Continue?" }),
    ]);
    writeLiveLock(sandbox);

    const startedAt = Date.now();
    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.state).toBe("waiting");
    expect(result.waits).toHaveLength(1);
  });

  it("an explicit cursor overrides the persisted cursor", async () => {
    const sandbox = createSandbox();
    const lines = [eventLine("workflow.started", 1), eventLine("step.started", 2)];
    appendLines(sandbox, lines);
    writeLiveLock(sandbox);

    await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    const fromStart = await trst_watch(
      { runId: "run-1", cursor: 0, verbosity: "full" },
      quickOptions(sandbox),
    );

    expect(fromStart.lines).toEqual(lines);
    expect(fromStart.cursor).toBe(byteLength(`${lines.join("\n")}\n`));
  });

  it("waitFor terminal polls through a pending wait to the deadline and still reports waiting", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      waitLine(2, { waitId: "approval", question: "Approve?" }),
    ]);
    // Advance the cursor so the terminal-wait call really has nothing new to read.
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    const startedAt = Date.now();
    const result = await trst_watch(
      { runId: "run-1", waitFor: "terminal" },
      quickOptions(sandbox, 300),
    );
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
    expect(result.effectiveWaitMs).toBe(300);
    expect(result.state).toBe("waiting");
    expect(result.waits).toEqual([
      {
        waitId: "approval",
        branchId: "root",
        stepId: "step-1",
        question: "Approve?",
      },
    ]);
  });

  it("waitFor terminal returns early with a waiting snapshot when new events arrive", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      waitLine(2, { waitId: "approval", question: "Approve?" }),
    ]);
    // Advance the cursor so the terminal-wait call starts with nothing new.
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    setTimeout(() => {
      appendMoreLines(sandbox, [eventLine("step.progress", 3)]);
    }, 30);

    const startedAt = Date.now();
    const result = await trst_watch(
      { runId: "run-1", waitFor: "terminal" },
      quickOptions(sandbox, 3000),
    );
    const elapsed = Date.now() - startedAt;

    // waitFor terminal only ignores the wait at call start: a new event still
    // ends the poll, and the honest state is waiting with the pending wait.
    expect(elapsed).toBeLessThan(1500);
    expect(result.state).toBe("waiting");
    expect(result.waits).toHaveLength(1);
  });

  it("signal abort ends the poll promptly with a snapshot instead of throwing", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);
    writeLiveLock(sandbox);
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const startedAt = Date.now();
    const result = await trst_watch(
      { runId: "run-1" },
      { ...quickOptions(sandbox, 5000), signal: controller.signal },
    );
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000);
    expect(result.effectiveWaitMs).toBe(5000);
    expect(result.state).toBe("in-progress");
    expect(result.progress?.newEvents).toBe(0);
  });
});

describe("trst_watch progress hook and terminal failures", () => {
  it("calls onProgress immediately, then no faster than the configured cadence", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      eventLine("step.started", 2, {}, "delegate-turn"),
    ]);
    writeLiveLock(sandbox);
    // Advance the cursor so the watched call has nothing new to read.
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    const calls: { at: number; progress: TrstWatchProgressEvent }[] = [];
    const result = await trst_watch(
      { runId: "run-1", maxWaitMs: 420 },
      {
        ...quickOptions(sandbox, 420),
        progressCapable: true,
        progressIntervalMs: 100,
        onProgress: (progress) => {
          calls.push({ at: Date.now(), progress });
        },
      },
    );

    expect(result.state).toBe("in-progress");
    expect(result.effectiveWaitMs).toBe(420);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[0]?.progress).toEqual({
      state: "in-progress",
      step: "delegate-turn",
      lastEventType: "step.started",
      newEvents: 0,
      effectiveWaitMs: 420,
    });
    for (let index = 1; index < calls.length; index += 1) {
      const previous = calls[index - 1]?.at ?? 0;
      const current = calls[index]?.at ?? 0;
      expect(current - previous).toBeGreaterThanOrEqual(80);
    }
  });

  it("does not call onProgress after the signal aborts", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);
    writeLiveLock(sandbox);
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    const controller = new AbortController();
    let calls = 0;
    const watching = trst_watch(
      { runId: "run-1", maxWaitMs: 5000 },
      {
        ...quickOptions(sandbox, 5000),
        progressCapable: true,
        progressIntervalMs: 50,
        signal: controller.signal,
        onProgress: () => {
          calls += 1;
        },
      },
    );

    await sleep(160);
    controller.abort();
    const callsAtAbort = calls;
    const result = await watching;
    await sleep(150);

    expect(result.state).toBe("in-progress");
    expect(result.progress?.newEvents).toBe(0);
    expect(calls).toBe(callsAtAbort);
  });

  it("reports the failure object from workflow.failed and leaves output undefined", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      eventLine("workflow.failed", 2, {
        failure: { code: "step_failed", message: "The step exploded", details: { step: "x" } },
        message: "top-level failure message",
      }),
    ]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    expect(result.state).toBe("terminal");
    expect(result.failure).toEqual({
      code: "step_failed",
      message: "The step exploded",
      details: { step: "x" },
    });
    expect(result.output).toBeUndefined();
  });

  it("falls back to the terminal event's top-level message when the failure has none", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      eventLine("workflow.failed", 2, {
        failure: { code: "agent_failed" },
        message: "top-level failure message",
      }),
    ]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    expect(result.failure).toEqual({
      code: "agent_failed",
      message: "top-level failure message",
    });
    expect(result.output).toBeUndefined();
  });

  it("reports no failure for a cancelled run whose payload carries none", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      eventLine("workflow.cancelled", 2, {
        requestedAt: new Date(0).toISOString(),
        reason: "operator cancelled",
      }),
    ]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    expect(result.state).toBe("terminal");
    expect(result.failure).toBeUndefined();
    expect(result.output).toBeUndefined();
  });

  it("reports a cancelled run's failure when the payload carries one", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      eventLine("workflow.cancelled", 2, {
        reason: "cancelled",
        failure: { code: "cancelled_by_operator", message: "Stopped by the operator" },
      }),
    ]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 5000));

    expect(result.failure).toEqual({
      code: "cancelled_by_operator",
      message: "Stopped by the operator",
    });
    expect(result.output).toBeUndefined();
  });
});

describe("trst_watch cursor, resolution, and long-poll compatibility", () => {
  it("returns complete full-mode lines and leaves partial trailing lines for later", async () => {
    const sandbox = createSandbox();
    const lines = [eventLine("workflow.started", 1), eventLine("step.started", 2)];
    writeFileSync(
      sandbox.eventsFile,
      `${lines.join("\n")}\n${eventLine("step.completed", 3)}`,
      "utf8",
    );
    writeLiveLock(sandbox);

    const result = await trst_watch({ runId: "run-1", verbosity: "full" }, quickOptions(sandbox));

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

  it("reconnect reuses the persisted cursor and only counts new events", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);
    writeLiveLock(sandbox);

    const first = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(first.progress?.newEvents).toBe(2);

    appendMoreLines(sandbox, [eventLine("step.completed", 3)]);
    const reconnect = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(reconnect.progress?.newEvents).toBe(1);
    expect(reconnect.progress?.lastEventType).toBe("step.completed");
    expect(reconnect.cursor).toBeGreaterThan(first.cursor);
  });

  it("long-poll waits out its real budget when there is nothing new", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1)]);
    writeLiveLock(sandbox);
    const first = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));
    expect(first.progress?.newEvents).toBe(1);

    const startedAt = Date.now();
    const idle = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 250));
    const elapsed = Date.now() - startedAt;

    expect(idle.progress?.newEvents).toBe(0);
    expect(idle.cursor).toBe(first.cursor);
    // Real polling, not an instant fake return and not one fixed sleep of a
    // 20-30 s constant: the budget was actually waited out.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000);
  });

  it("long-poll returns early once new events appear mid-poll", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1)]);
    writeLiveLock(sandbox);
    await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    setTimeout(() => {
      appendMoreLines(sandbox, [eventLine("step.completed", 2)]);
    }, 30);

    const startedAt = Date.now();
    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox, 3000));
    const elapsed = Date.now() - startedAt;

    expect(result.progress?.newEvents).toBe(1);
    expect(result.progress?.lastEventType).toBe("step.completed");
    expect(result.state).toBe("in-progress");
    expect(elapsed).toBeLessThan(1500);
  });

  it("reports started for an empty trail inside the startup grace window", async () => {
    const sandbox = createSandbox();
    writeFileSync(sandbox.eventsFile, "", "utf8");

    const result = await trst_watch(
      { runId: "run-1", maxWaitMs: 0 },
      { ...quickOptions(sandbox, 0), startupGraceMs: 60_000 },
    );
    expect(result.state).toBe("started");
    expect(result.crash).toBeUndefined();
    expect(result.lines).toEqual([]);
    expect(result.cursor).toBe(0);
    expect(result.progress?.newEvents).toBe(0);
  });

  it("reports crashed for an empty trail with no lock once the startup grace window has passed", async () => {
    const sandbox = createSandbox();
    writeFileSync(sandbox.eventsFile, "", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(sandbox.eventsFile, old, old);

    const result = await trst_watch(
      { runId: "run-1" },
      { ...quickOptions(sandbox, 5000), startupGraceMs: 10_000 },
    );

    expect(result.state).toBe("crashed");
    expect(result.crash).toEqual({ reason: "run has no events and no live process" });
  });

  it("reports crashed for an empty trail whose lock is dead once the startup grace window has passed", async () => {
    const sandbox = createSandbox();
    writeFileSync(sandbox.eventsFile, "", "utf8");
    writeDeadLock(sandbox);
    const old = new Date(Date.now() - 60_000);
    utimesSync(sandbox.eventsFile, old, old);

    const result = await trst_watch(
      { runId: "run-1" },
      { ...quickOptions(sandbox, 5000), startupGraceMs: 10_000 },
    );

    expect(result.state).toBe("crashed");
    expect(result.crash).toEqual({ reason: "run has no events and no live process" });
  });

  it("keeps an empty trail started while a live lock holds the run, even past the grace window", async () => {
    const sandbox = createSandbox();
    writeFileSync(sandbox.eventsFile, "", "utf8");
    writeLiveLock(sandbox);
    const old = new Date(Date.now() - 60_000);
    utimesSync(sandbox.eventsFile, old, old);

    const result = await trst_watch(
      { runId: "run-1", maxWaitMs: 0 },
      { ...quickOptions(sandbox, 0), startupGraceMs: 10_000 },
    );

    expect(result.state).toBe("started");
    expect(result.crash).toBeUndefined();
  });

  it("leaves a non-empty in-progress trail unaffected by the startup grace window", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);
    writeLiveLock(sandbox);
    const old = new Date(Date.now() - 60_000);
    utimesSync(sandbox.eventsFile, old, old);

    const result = await trst_watch(
      { runId: "run-1", maxWaitMs: 0 },
      { ...quickOptions(sandbox, 0), startupGraceMs: 10_000 },
    );

    expect(result.state).toBe("in-progress");
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
        trst_watch({ runId: "run-1", cursor: 0, verbosity: "full" }, quickOptions(sandbox)),
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
    const envSandbox = { root, runDir, cursorDir, eventsFile };
    sandboxes.push(envSandbox);
    writeLiveLock(envSandbox);

    const base = { cwd: root, cursorDir, maxWaitMs: 250, pollIntervalMs: 5 };

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
    expect(result.progress?.newEvents).toBe(1);
  });

  it("fails clearly for an unknown run and for missing runId", async () => {
    const sandbox = createSandbox();
    await expect(trst_watch({ runId: "nope" }, quickOptions(sandbox))).rejects.toThrow(
      /run not found/u,
    );
    await expect(trst_watch({} as TrstWatchParams, quickOptions(sandbox))).rejects.toThrow(
      /runId/u,
    );
  });

  it("reports crashed when the run lock is held by a dead pid", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [eventLine("workflow.started", 1), eventLine("step.started", 2)]);
    writeDeadLock(sandbox);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    expect(result.state).toBe("crashed");
    expect(result.crash?.reason).toBe("no terminal event and no live lock");
  });

  it("does not report terminal for event-shaped text embedded in a display payload", async () => {
    const sandbox = createSandbox();
    appendLines(sandbox, [
      eventLine("workflow.started", 1),
      eventLine("step.started", 2),
      eventLine("step.display", 3, {
        text: 'agent said: {"type":"workflow.completed","payload":{}}',
      }),
    ]);

    const result = await trst_watch({ runId: "run-1" }, quickOptions(sandbox));

    // A naive text scan would have matched the embedded fragment and stopped
    // watching a run that is still going (here: dead, which is the real state).
    expect(result.state).not.toBe("terminal");
    expect(result.state).toBe("crashed");
  });
});
