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

describe("watch command", () => {
  it("prints existing events for a completed run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
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

    await expect(
      main({
        argv: ["watch", "completed-run"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toContain("→ Delegate turn (agent)");
    expect(lines).toContain("• Found likely issue in parser normalization");
    expect(lines).toContain("✓ delegate-turn");
    expect(lines).toContain("✓ Workflow completed");
  });

  it("follows a live run and receives appended events", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeRunEvents(cwd, "live-run", [
      event("step.started", { stepId: "delegate-turn", payload: { title: "Delegate turn" } }),
    ]);
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
    await rm(cwd, { recursive: true, force: true });
    await writeRunEvents(cwd, "waiting-run", [
      event("wait.started", {
        stepId: "delegate-turn",
        payload: { waitId: "approval", kind: "input", message: "Should I update snapshots?" },
      }),
    ]);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["watch", "waiting-run"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual(["? Waiting for approval: Should I update snapshots?"]);
  });

  it("prints parseable JSONL", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
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

  it("fails clearly for a missing run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
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
    await rm(cwd, { recursive: true, force: true });
    await writeRunEvents(cwd, "terminal-run", [event("step.started", { stepId: "one" })]);

    const watchPromise = main({
      argv: ["watch", "terminal-run", "--jsonl"],
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
    });

    await sleep(75);
    await appendRunEvent(cwd, "terminal-run", event("workflow.completed"));

    await expect(watchPromise).resolves.toBe(0);
  });

  it("ignores a partially-written trailing line", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-watch-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    const runDir = await writeRunEvents(cwd, "partial-run", [
      event("step.display", { stepId: "delegate-turn", payload: { message: "Complete line" } }),
    ]);
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
