import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Event } from "@trailstep/core";
import { describe, expect, it } from "vitest";
import { main } from "../../../index.js";

function event(
  type: Event["type"],
  options: { readonly stepId?: string; readonly payload?: Record<string, unknown> } = {},
): Event {
  return {
    id: `${type}-${options.stepId ?? "workflow"}`,
    runId: "watch-run",
    workflowId: "watch-workflow",
    ...(options.stepId ? { stepId: options.stepId } : {}),
    type,
    timestamp: "2024-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: options.payload ?? {},
  };
}

async function writeRunEvents(
  cwd: string,
  runName: string,
  events: readonly Event[],
): Promise<string> {
  const runDir = join(cwd, ".trailstep", "runs", runName);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "events.jsonl"),
    `${events.map((runEvent) => JSON.stringify(runEvent)).join("\n")}\n`,
    "utf8",
  );
  return runDir;
}

async function appendRunEvent(cwd: string, runName: string, runEvent: Event): Promise<void> {
  await appendFile(
    join(cwd, ".trailstep", "runs", runName, "events.jsonl"),
    `${JSON.stringify(runEvent)}\n`,
    "utf8",
  );
}

async function writeRunTrack(
  cwd: string,
  runName: string,
  status = "running",
  ownerPid: number = process.pid,
): Promise<void> {
  await writeFile(
    join(cwd, ".trailstep", "runs", runName, "track.json"),
    `${JSON.stringify({
      runId: runName,
      workflowId: "watch-workflow",
      status,
      ownerPid,
    })}\n`,
    "utf8",
  );
}

async function writeTrackOnlyRun(cwd: string, runName: string): Promise<void> {
  await mkdir(join(cwd, ".trailstep", "runs", runName), { recursive: true });
  await writeRunTrack(cwd, runName);
}

describe("watch command", () => {
  it("prints existing events for a completed run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "completed-run", [
      event("step.started", {
        stepId: "delegate-turn",
        payload: { title: "Delegate turn", kind: "agent" },
      }),
      event("step.display", {
        stepId: "delegate-turn",
        payload: { message: "Found likely issue in parser normalization" },
      }),
      event("step.completed", { stepId: "delegate-turn" }),
      event("workflow.completed", { payload: { output: { ok: true } } }),
    ]);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "completed-run"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(0);

    expect(errors).toEqual([]);
    expect(lines).toContain("→ Delegate turn (agent)");
    expect(lines).toContain("• Found likely issue in parser normalization");
    expect(lines).toContain("✓ delegate-turn");
    expect(lines).toContain("✓ Workflow completed");
  });

  it("follows a live run and receives appended events", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "live-run", [
      event("step.started", { stepId: "delegate-turn", payload: { title: "Delegate turn" } }),
    ]);
    await writeRunTrack(cwd, "live-run");
    const lines: string[] = [];

    const watchPromise = main({
      argv: ["watch", "live-run"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    await sleep(75);
    await appendRunEvent(
      cwd,
      "live-run",
      event("step.display", {
        stepId: "delegate-turn",
        payload: { message: "Appended while watching" },
      }),
    );
    await appendRunEvent(cwd, "live-run", event("workflow.completed"));

    await expect(watchPromise).resolves.toBe(0);
    expect(lines).toContain("• Appended while watching");
  });

  it("prints a waiting run and exits", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "waiting-run", [
      event("wait.started", {
        stepId: "delegate-turn",
        payload: { waitId: "approval", kind: "input", message: "Should I update snapshots?" },
      }),
    ]);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "waiting-run"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(0);

    expect(errors).toEqual([]);
    expect(lines).toEqual(["? Waiting for approval: Should I update snapshots?"]);
  });

  it("prints parseable JSONL", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "jsonl-run", [
      event("step.progress", { stepId: "delegate-turn", payload: { message: "Halfway" } }),
      event("workflow.completed"),
    ]);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["watch", "jsonl-run", "--jsonl"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { type: "step.progress", payload: { message: "Halfway" } },
      { type: "workflow.completed" },
    ]);
  });

  it("treats a track-only run as an empty trail with --no-follow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeTrackOnlyRun(cwd, "track-only-run");
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "track-only-run", "--no-follow"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("keeps polling a track-only run and prints the first appended event", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeTrackOnlyRun(cwd, "track-only-follow-run");
    const lines: string[] = [];

    const watchPromise = main({
      argv: ["watch", "track-only-follow-run"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    await sleep(75);
    await appendRunEvent(
      cwd,
      "track-only-follow-run",
      event("step.display", {
        stepId: "delegate-turn",
        payload: { message: "First event after publish" },
      }),
    );
    await appendRunEvent(cwd, "track-only-follow-run", event("workflow.completed"));

    await expect(watchPromise).resolves.toBe(0);
    expect(lines).toContain("• First event after publish");
  });

  it("fails when the run directory disappears while following", { timeout: 5_000 }, async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const runDir = await writeRunEvents(cwd, "vanishing-run", [
      event("step.started", { stepId: "delegate-turn" }),
    ]);
    await writeRunTrack(cwd, "vanishing-run");
    const errors: string[] = [];

    const watchPromise = main({
      argv: ["watch", "vanishing-run"],
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    await sleep(75);
    await rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

    await expect(watchPromise).resolves.toBe(1);
    expect(errors.join("\n")).toContain("Run not found or unreadable: vanishing-run");
  });

  it("fails clearly for a missing run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "missing-run"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("Run not found or unreadable: missing-run");
  });

  it("exits when workflow.completed is appended", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "terminal-run", [event("step.started", { stepId: "one" })]);
    await writeRunTrack(cwd, "terminal-run");

    const watchPromise = main({
      argv: ["watch", "terminal-run", "--jsonl"],
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
    });

    await sleep(75);
    await appendRunEvent(cwd, "terminal-run", event("workflow.completed"));

    await expect(watchPromise).resolves.toBe(0);
  });

  it("stops on a canonical unknown state (crashed through unknown)", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "crashed-run", [event("step.started", { stepId: "delegate-turn" })]);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "crashed-run", "--jsonl"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(3);

    expect(errors.join("\n")).toContain("Watch stopped: run state is unknown.");
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ type: "step.started" }]);
  });

  it("stops with a reason and exit code 2 when the run crashed", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "stale-run", [event("step.started", { stepId: "delegate-turn" })]);
    await writeRunTrack(cwd, "stale-run", "running", 2_147_483_646);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "stale-run", "--jsonl"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(2);

    expect(errors.join("\n")).toContain("Watch stopped: run crashed.");
    expect(errors.join("\n")).toContain("owner process is no longer alive");
    // JSONL stdout stays events-only: the stop reason never pollutes it.
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ type: "step.started" }]);
  });

  it("stops with a reason and exit code 3 when the run state is unknown", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "unknown-run", [event("step.started", { stepId: "delegate-turn" })]);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "unknown-run", "--json"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(3);

    expect(errors.join("\n")).toContain("Watch stopped: run state is unknown.");
    expect(errors.join("\n")).toContain("Track metadata is missing");
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ type: "step.started" }]);
  });

  it("applies the crashed exit code with --no-follow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "no-follow-stale-run", [
      event("step.started", { stepId: "delegate-turn" }),
    ]);
    await writeRunTrack(cwd, "no-follow-stale-run", "running", 2_147_483_646);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "no-follow-stale-run", "--jsonl", "--no-follow"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(2);

    expect(errors.join("\n")).toContain("Watch stopped: run crashed.");
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ type: "step.started" }]);
  });

  it("applies the unknown exit code with --no-follow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "no-follow-unknown-run", [
      event("step.started", { stepId: "delegate-turn" }),
    ]);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "no-follow-unknown-run", "--json", "--no-follow"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(3);

    expect(errors.join("\n")).toContain("Watch stopped: run state is unknown.");
  });

  it("reports a bare cancellation as unknown with exit code 3", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "cancel-requested-run", [
      event("workflow.cancelRequested", { payload: { reason: "operator" } }),
    ]);
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "cancel-requested-run", "--jsonl"],
        cwd,
        io: {
          writeLine: (line) => lines.push(line),
          writeError: (line) => errors.push(line),
        },
      }),
    ).resolves.toBe(3);

    expect(errors.join("\n")).toContain("Watch stopped: run state is unknown.");
    expect(errors.join("\n")).toContain(
      "A cancellation was requested but no terminal event has been recorded.",
    );
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { type: "workflow.cancelRequested" },
    ]);
  });

  it("stops with a reason when the track says waiting without a pending wait", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeRunEvents(cwd, "waiting-track-run", [event("step.started", { stepId: "one" })]);
    await writeRunTrack(cwd, "waiting-track-run", "waiting");
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "waiting-track-run", "--jsonl"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(errors.join("\n")).toContain(
      "Watch stopped: the track reports waiting, but no pending wait exists.",
    );
  });

  it("skips and reports a malformed event line without crashing the watcher", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const runDir = await writeRunEvents(cwd, "malformed-run", [
      event("step.display", { stepId: "delegate-turn", payload: { message: "Before" } }),
    ]);
    await writeRunTrack(cwd, "malformed-run");
    await appendFile(join(runDir, "events.jsonl"), "{not json}\n", "utf8");
    await appendFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(event("step.progress", { payload: { message: "After" } }))}\n`,
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "malformed-run", "--jsonl", "--no-follow"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(errors.join("\n")).toContain("Unable to parse event JSONL");
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { type: "step.display" },
      { type: "step.progress" },
    ]);
  });

  it("skips and reports a line that is not a TrailStep event", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const runDir = await writeRunEvents(cwd, "shape-run", [
      event("step.display", { stepId: "delegate-turn", payload: { message: "Before" } }),
    ]);
    await writeRunTrack(cwd, "shape-run");
    await appendFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ hello: "world" })}\n`,
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["watch", "shape-run", "--jsonl", "--no-follow"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(errors.join("\n")).toContain("Unexpected event shape");
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([{ type: "step.display" }]);
  });

  it("ignores a partially-written trailing line", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    const runDir = await writeRunEvents(cwd, "partial-run", [
      event("step.display", { stepId: "delegate-turn", payload: { message: "Complete line" } }),
    ]);
    await writeRunTrack(cwd, "partial-run");
    await appendFile(join(runDir, "events.jsonl"), '{"id":"partial"', "utf8");
    const lines: string[] = [];

    await expect(
      main({
        argv: ["watch", "partial-run", "--jsonl", "--no-follow"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      type: "step.display",
      payload: { message: "Complete line" },
    });
  });
});
