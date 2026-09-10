import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";
import { cancelCommand } from "./cancel-command.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeEvents(
  runDir: string,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  await writeFile(
    join(runDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function event(
  type: string,
  options: {
    readonly runId: string;
    readonly workflowId: string;
    readonly stepId?: string;
    readonly payload?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    id: `${type}-${Math.random().toString(36).slice(2)}`,
    runId: options.runId,
    workflowId: options.workflowId,
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: options.payload ?? {},
  };
}

function interactiveProtocol(options: { runDir: string; stepDir: string }) {
  return {
    status: "active",
    stepId: "discuss-feature",
    artifactStepId: "0001-discuss-feature",
    outputMode: "json",
    stepDir: options.stepDir,
    promptFile: join(options.stepDir, "prompt.txt"),
    outputFile: join(options.stepDir, "output.json"),
    interactiveFile: join(options.stepDir, "interactive.json"),
    runRelativeStepDir: "steps/0001-discuss-feature",
    outputSchema: {
      type: "object",
      properties: { approved: { type: "boolean" }, notes: { type: "string" } },
      required: ["approved", "notes"],
      additionalProperties: false,
    },
    runDir: options.runDir,
  };
}

describe("cancel command", () => {
  it("cancels an active interactive session", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-active`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir }));
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel"],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "cancelled"');
    expect(lines.join("\n")).toMatch(/interactive session cancelled/i);
    expect(errors).toEqual([]);
  });

  it("records an optional cancellation reason", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-reason`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, interactiveProtocol({ runDir, stepDir }));
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel", "--reason", "Requirements changed."],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "cancelled"');
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain("Requirements changed.");
    expect(errors).toEqual([]);
  });

  it("requests cancellation for a waiting workflow run and records durable events", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-waiting-run`);
    await rm(cwd, { recursive: true, force: true });
    const runDir = join(cwd, ".trailstep", "runs", "delegate-run");
    await mkdir(runDir, { recursive: true });
    await writeEvents(runDir, [
      event("workflow.started", { runId: "delegate-run", workflowId: "delegate" }),
      event("step.started", { runId: "delegate-run", workflowId: "delegate", stepId: "ask" }),
      event("wait.started", {
        runId: "delegate-run",
        workflowId: "delegate",
        stepId: "ask",
        payload: {
          waitId: "approval",
          message: "Approve?",
          artifactPaths: { answerFile: "steps/0001-ask/waits/approval/answer.json" },
        },
      }),
    ]);
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel", "delegate-run", "--reason", "Parent stopped."],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    await expect(readFile(join(runDir, "cancel.json"), "utf8")).resolves.toContain(
      "Parent stopped.",
    );
    const eventText = await readFile(join(runDir, "events.jsonl"), "utf8");
    expect(eventText).toContain("workflow.cancelRequested");
    expect(eventText).toContain("step.cancelled");
    expect(eventText).toContain("workflow.cancelled");
    expect(lines.join("\n")).toContain("Cancellation requested: delegate-run");
    expect(errors).toEqual([]);
  });

  it("reports an already completed workflow run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-completed-run`);
    await rm(cwd, { recursive: true, force: true });
    const runDir = join(cwd, ".trailstep", "runs", "delegate-run");
    await mkdir(runDir, { recursive: true });
    await writeEvents(runDir, [
      event("workflow.started", { runId: "delegate-run", workflowId: "delegate" }),
      event("workflow.completed", { runId: "delegate-run", workflowId: "delegate" }),
    ]);
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["cancel", "delegate-run"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("Run already completed: delegate-run");
  });

  it("is idempotent for an already cancelled workflow run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-cancelled-run`);
    await rm(cwd, { recursive: true, force: true });
    const runDir = join(cwd, ".trailstep", "runs", "delegate-run");
    await mkdir(runDir, { recursive: true });
    await writeEvents(runDir, [
      event("workflow.started", { runId: "delegate-run", workflowId: "delegate" }),
    ]);
    await writeJson(join(runDir, "cancel.json"), { requestedAt: "2026-01-01T00:00:00.000Z" });
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["cancel", "delegate-run"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("Run already cancelled: delegate-run");
  });

  it("rejects an already completed session", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-completed`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, {
      ...interactiveProtocol({ runDir, stepDir }),
      status: "completed",
    });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel"],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "completed"');
    expect(errors.join("\n")).toMatch(/not active/i);
  });

  it("rejects an already cancelled session", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-cancel-tests", `${task.id}-cancelled`);
    const runDir = join(cwd, ".trailstep", "runs", "interactive-run");
    const stepDir = join(runDir, "steps", "0001-approve-plan");
    const interactiveFile = join(stepDir, "interactive.json");
    await mkdir(stepDir, { recursive: true });
    await writeJson(interactiveFile, {
      ...interactiveProtocol({ runDir, stepDir }),
      status: "cancelled",
    });
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["cancel"],
      env: { TRAILSTEP_INTERACTIVE_FILE: interactiveFile },
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    await expect(readFile(interactiveFile, "utf8")).resolves.toContain('"status": "cancelled"');
    expect(errors.join("\n")).toMatch(/not active/i);
  });

  it("requires TRAILSTEP_INTERACTIVE_FILE", async () => {
    const errors: string[] = [];

    await expect(
      cancelCommand.run(
        {},
        {
          cwd: ".",
          env: {},
          io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        },
      ),
    ).rejects.toThrow(/TRAILSTEP_INTERACTIVE_FILE/i);

    expect(errors).toEqual([]);
  });
});
