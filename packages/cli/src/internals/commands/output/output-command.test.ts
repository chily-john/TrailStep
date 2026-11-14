import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../index.js";

async function writeEvents(
  cwd: string,
  runName: string,
  events: readonly unknown[],
): Promise<void> {
  const runDir = join(cwd, ".trailstep", "runs", runName);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function event(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `${type}-1`,
    runId: "run-1",
    workflowId: "workflow-1",
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload,
  };
}

async function runCli(
  cwd: string,
  argv: readonly string[],
): Promise<{
  readonly code: number;
  readonly lines: readonly string[];
  readonly errors: readonly string[];
}> {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await main({
    argv: [...argv],
    cwd,
    io: {
      writeLine: (line) => lines.push(line),
      writeError: (line) => errors.push(line),
    },
  });
  return { code, lines, errors };
}

describe("output command", () => {
  it("prints a selected final output field", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "complete-run", [
      event("workflow.completed", { output: { summary: "completed tests" } }),
    ]);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["output", "complete-run", "--field", "summary"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual(["completed tests"]);
  });

  it("prints the persisted terminal message", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "complete-run", [
      event("workflow.completed", {
        output: { summary: "completed tests" },
        message: "Finished tests",
      }),
    ]);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["output", "complete-run", "--message"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual(["Finished tests"]);
  });

  it("prints the persisted terminal message for failed runs", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "failed-run", [
      event("workflow.failed", {
        failure: { code: "rejected", message: "Rejected tests" },
        message: "Could not finish tests",
      }),
    ]);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["output", "failed-run", "--message"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual(["Could not finish tests"]);
  });

  it("does not print an earlier cycle's output after a resume", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "reopened-running-run", [
      event("workflow.completed", { output: "old result" }),
      event("workflow.resumed", {}),
      event("step.started", { stepId: "next-step" }),
    ]);

    const result = await runCli(cwd, ["output", "reopened-running-run"]);

    expect(result.lines).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain(
      "No final workflow output found for reopened-running-run",
    );
    expect(result.errors.join("\n")).toContain("run status is not completed");
  });

  it("does not print an earlier cycle's failure message after a resume", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "reopened-failed-run", [
      event("workflow.failed", {
        failure: { code: "rejected", message: "Rejected tests" },
        message: "Old failure message",
      }),
      event("workflow.resumed", {}),
      event("step.started", { stepId: "next-step" }),
    ]);

    const result = await runCli(cwd, ["output", "reopened-failed-run", "--message"]);

    expect(result.lines).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain(
      "No final workflow message found for reopened-failed-run",
    );
  });

  it("reports waiting for the current cycle after a retry, not the earlier completion", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "retried-waiting-run", [
      event("workflow.completed", { output: "old result" }),
      event("workflow.retryStarted", {}),
      event("wait.started", { waitId: "approval", message: "Approve" }),
    ]);

    const result = await runCli(cwd, ["output", "retried-waiting-run"]);

    expect(result.lines).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain(
      "No final workflow output found for retried-waiting-run",
    );
    expect(result.errors.join("\n")).toContain("run status is waiting");
  });

  it("prints only the current cycle's completion after an earlier failure", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "resumed-completed-run", [
      event("workflow.failed", {
        failure: { code: "rejected", message: "Rejected tests" },
        message: "Old failure message",
      }),
      event("workflow.resumed", {}),
      event("workflow.completed", { output: "new result" }),
    ]);

    const result = await runCli(cwd, ["output", "resumed-completed-run"]);

    expect(result.code).toBe(0);
    expect(result.lines).toEqual([JSON.stringify("new result")]);
    expect(result.errors).toEqual([]);
  });

  it("prints only the current cycle's failure message after an earlier completion", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "resumed-failed-run", [
      event("workflow.completed", {
        output: "old result",
        message: "Old completion message",
      }),
      event("workflow.resumed", {}),
      event("workflow.failed", {
        failure: { code: "rejected", message: "Rejected tests" },
        message: "New failure message",
      }),
    ]);

    const result = await runCli(cwd, ["output", "resumed-failed-run", "--message"]);

    expect(result.code).toBe(0);
    expect(result.lines).toEqual(["New failure message"]);
    expect(result.errors).toEqual([]);
  });

  it("does not describe a current-cycle cancellation with an earlier wait or result", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "cancelled-after-reopen-run", [
      event("workflow.completed", {
        output: "old result",
        message: "Old completion message",
      }),
      event("wait.started", { waitId: "approval", message: "Approve" }),
      event("workflow.resumed", {}),
      event("workflow.cancelRequested", {}),
      event("workflow.cancelled", {}),
    ]);

    const output = await runCli(cwd, ["output", "cancelled-after-reopen-run"]);

    expect(output.lines).toEqual([]);
    expect(output.code).toBe(1);
    expect(output.errors.join("\n")).toContain("run status is cancelled");
    expect(output.errors.join("\n")).not.toContain("run status is waiting");

    const message = await runCli(cwd, ["output", "cancelled-after-reopen-run", "--message"]);

    expect(message.lines).toEqual([]);
    expect(message.code).toBe(1);
    expect(message.errors.join("\n")).toContain(
      "No final workflow message found for cancelled-after-reopen-run",
    );
  });

  it("describes a current-cycle cancellation instead of an earlier pending wait", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "cancelled-waiting-run", [
      event("wait.started", { waitId: "approval", message: "Approve" }),
      event("workflow.resumed", {}),
      event("workflow.cancelRequested", {}),
      event("workflow.cancelled", {}),
    ]);

    const result = await runCli(cwd, ["output", "cancelled-waiting-run"]);

    expect(result.code).toBe(1);
    expect(result.lines).toEqual([]);
    expect(result.errors.join("\n")).toContain("run status is cancelled");
    expect(result.errors.join("\n")).not.toContain("run status is waiting");
  });

  it("describes a current-cycle completion when there is no final output", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "completed-without-output-run", [
      event("workflow.completed", { message: "Finished without output" }),
    ]);

    const result = await runCli(cwd, ["output", "completed-without-output-run"]);

    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain("run status is completed");
  });

  it("describes a current-cycle failure when there is no final output", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "failed-without-output-run", [
      event("workflow.failed", {
        failure: { code: "rejected", message: "Rejected tests" },
        message: "Failed without output",
      }),
    ]);

    const result = await runCli(cwd, ["output", "failed-without-output-run"]);

    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain("run status is failed");
  });

  it("keeps ordinary single-cycle output and --json formatting", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "single-cycle-run", [
      event("workflow.completed", { output: "plain result" }),
    ]);

    const plain = await runCli(cwd, ["output", "single-cycle-run"]);

    expect(plain.code).toBe(0);
    expect(plain.lines).toEqual([JSON.stringify("plain result")]);

    const json = await runCli(cwd, ["output", "single-cycle-run", "--json"]);

    expect(json.code).toBe(0);
    expect(json.lines).toEqual([JSON.stringify("plain result")]);
  });

  it("tells users to restore archived runs before reading output", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await mkdir(join(cwd, ".trailstep", "runs", ".archive"), { recursive: true });
    await writeFile(
      join(cwd, ".trailstep", "runs", ".archive", "archived-run.manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, runId: "archived-run" })}\n`,
      "utf8",
    );
    const errors: string[] = [];

    await expect(
      main({
        argv: ["output", "archived-run"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("Run archived-run is archived");
    expect(errors.join("\n")).toContain("trailstep storage restore archived-run");
  });

  it("reports no final output for a waiting run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await writeEvents(cwd, "waiting-run", [event("wait.started", { waitId: "approval" })]);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["output", "waiting-run"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("No final workflow output found for waiting-run");
    expect(errors.join("\n")).toContain("run status is waiting");
  });
});
