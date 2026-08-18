import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendEvent,
  createRunDirectory,
  readRunEvents,
  readRunState,
  writeRunState,
} from "./run-storage.js";

describe("run storage", () => {
  it("appendEvent appends newline-delimited events without rewriting previous lines", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "event-run" });

    await appendEvent(runDir, {
      id: "event-1",
      runId: "event-run",
      workflowId: "append-workflow",
      type: "workflow.started",
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: "v0",
      payload: { input: { value: 1 } },
    });
    await appendEvent(runDir, {
      id: "event-2",
      runId: "event-run",
      workflowId: "append-workflow",
      type: "workflow.completed",
      timestamp: "2026-01-01T00:00:01.000Z",
      schemaVersion: "v0",
      payload: { output: { value: 2 } },
    });

    const lines = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as { readonly id: string })).toEqual([
      expect.objectContaining({ id: "event-1" }),
      expect.objectContaining({ id: "event-2" }),
    ]);
  });

  it("readRunEvents ignores one unparseable trailing line", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "partial-run" });

    await appendEvent(runDir, {
      id: "event-1",
      runId: "partial-run",
      workflowId: "partial-workflow",
      type: "workflow.started",
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: "v0",
      payload: { input: { value: 1 } },
    });
    await writeFile(
      join(runDir, "events.jsonl"),
      '{"id":"event-1","runId":"partial-run","workflowId":"partial-workflow","type":"workflow.started","timestamp":"2026-01-01T00:00:00.000Z","schemaVersion":"v0","payload":{"input":{"value":1}}}\n{"partial"',
      "utf8",
    );

    await expect(readRunEvents(runDir)).resolves.toEqual([
      expect.objectContaining({ id: "event-1", type: "workflow.started" }),
    ]);
  });

  it("rejects run names that would escape the runs root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await expect(createRunDirectory({ cwd, runName: "../escape" })).rejects.toMatchObject({
      failure: { code: "run_name_invalid" },
    });
  });

  it("creates a .trailstep/.gitignore file that ignores everything except itself", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await createRunDirectory({ cwd, runName: "first-run" });

    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    const contents = await readFile(gitignorePath, "utf8");
    expect(contents).toBe("*\n!.gitignore\n");
  });

  it("does not throw or corrupt the .gitignore file on a second run in the same cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await createRunDirectory({ cwd, runName: "first-run" });
    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    const firstContents = await readFile(gitignorePath, "utf8");

    await expect(createRunDirectory({ cwd, runName: "second-run" })).resolves.toMatchObject({
      runId: "second-run",
    });

    const secondContents = await readFile(gitignorePath, "utf8");
    expect(secondContents).toBe(firstContents);
    expect(secondContents).toBe("*\n!.gitignore\n");
  });

  it("persists run state as state.json and reads it from a second helper call", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "state-run" });

    await expect(readRunState(runDir)).resolves.toEqual({});

    await writeRunState(runDir, { count: { value: 1 } });

    await expect(readRunState(runDir)).resolves.toEqual({ count: { value: 1 } });
    await expect(readFile(join(runDir, "state.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ count: { value: 1 } }, null, 2)}\n`,
    );
  });
});
