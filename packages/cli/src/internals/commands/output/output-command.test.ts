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

describe("output command", () => {
  it("prints a selected final output field", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
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
    await rm(cwd, { recursive: true, force: true });
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
    await rm(cwd, { recursive: true, force: true });
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

  it("tells users to restore archived runs before reading output", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
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
    await rm(cwd, { recursive: true, force: true });
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
