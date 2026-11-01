import { mkdir, mkdtemp, open, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import {
  appendEvent,
  atomicWriteJson,
  createRunDirectory,
  readJsonStateArtifact,
  readRunEvents,
  readRunEventsSince,
  readRunState,
  TRAILSTEP_GITIGNORE_BODY,
  writeJsonStateArtifact,
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

  it("readRunEvents skips a torn middle line and returns the rest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "torn-middle-run" });
    const first = makeEvent("workflow.started");
    const second = makeEvent("step.started");
    const third = makeEvent("workflow.completed");
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(first)}\n{"id":"e2","type":"step.sta\n${JSON.stringify(second)}\n${JSON.stringify(third)}\n`,
      "utf8",
    );

    const reported: string[] = [];
    const events = await readRunEvents(runDir, {
      report: (message) => reported.push(message),
    });

    expect(events.map((event) => event.id)).toEqual([first.id, second.id, third.id]);
    expect(reported).toHaveLength(1);
    expect(reported.join("\n")).toContain("line 2");
  });

  it("readRunEvents skips a line that parses as JSON but is not event-shaped", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "non-event-line-run" });
    const first = makeEvent("workflow.started");
    const second = makeEvent("workflow.completed");
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(first)}\n{"hello":"world"}\n${JSON.stringify(second)}\n`,
      "utf8",
    );

    const reported: string[] = [];
    const events = await readRunEvents(runDir, {
      report: (message) => reported.push(message),
    });

    expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(reported.join("\n")).toContain("Unexpected event shape");
  });

  it("readRunEvents still throws resume_target_not_found when the trail is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const missingRunDir = join(cwd, "missing-run");

    await expect(readRunEvents(missingRunDir)).rejects.toMatchObject({
      failure: {
        code: "resume_target_not_found",
        details: { runDir: missingRunDir, causeCode: "ENOENT" },
      },
    });
  });

  it("readRunEvents works with no options argument", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "no-options-run" });
    const event = makeEvent("workflow.started");
    await appendEvent(runDir, event);

    await expect(readRunEvents(runDir)).resolves.toEqual([event]);
  });

  it("serializes concurrent appendEvent calls into a fully parseable trail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "concurrent-append-run" });
    const events = Array.from({ length: 50 }, (_, index) => ({
      ...makeEvent("step.progress"),
      id: `evt_concurrent_${index}`,
      payload: { big: "x".repeat(100_000) },
    }));

    await Promise.all(events.map((event) => appendEvent(runDir, event)));

    const trail = await readFile(join(runDir, "events.jsonl"), "utf8");
    expect(trail.split("\n").filter((line) => line.length > 0)).toHaveLength(50);

    const readBack = await readRunEvents(runDir);
    expect(readBack.map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it("rejects run names that would escape the runs root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await expect(createRunDirectory({ cwd, runName: "../escape" })).rejects.toMatchObject({
      failure: { code: "run_name_invalid" },
    });
  });

  it("creates a .trailstep/.gitignore that ignores run artifacts but not the committed config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await createRunDirectory({ cwd, runName: "first-run" });

    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    const contents = await readFile(gitignorePath, "utf8");
    expect(contents).toBe(TRAILSTEP_GITIGNORE_BODY);
    expect(contents).toContain("runs/");
    expect(contents).toContain("config-local.json");
    expect(contents.split("\n")).not.toContain("*");
    expect(contents).not.toContain("!config.json");
  });

  it("repairs the legacy blanket .gitignore body in place", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    await writeFile(gitignorePath, "*\n!.gitignore\n", "utf8");

    await createRunDirectory({ cwd, runName: "legacy-gitignore-run" });

    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(TRAILSTEP_GITIGNORE_BODY);
  });

  it("never rewrites a hand-edited .gitignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    // This repo's hand-fixed body: not the legacy generated one, so it is the user's.
    const handEdited = "*\n!.gitignore\n!config.json\n";
    await writeFile(gitignorePath, handEdited, "utf8");

    await createRunDirectory({ cwd, runName: "hand-edited-gitignore-run" });

    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(handEdited);
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
    expect(secondContents).toBe(TRAILSTEP_GITIGNORE_BODY);
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

  it("atomicWriteJson leaves no *.tmp file behind on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "state.json");

    await atomicWriteJson(target, { hello: "world", nested: { n: 1 } });

    await expect(readFile(target, "utf8")).resolves.toBe(
      `${JSON.stringify({ hello: "world", nested: { n: 1 } }, null, 2)}\n`,
    );
    expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("atomicWriteJson rejects and removes its tmp file when the rename cannot complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "blocked.json");
    // Occupy the target with a directory so the final same-directory rename
    // must fail after the tmp file has already been written.
    await mkdir(target);

    await expect(atomicWriteJson(target, { a: 1 })).rejects.toBeInstanceOf(Error);

    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("writeJsonStateArtifact round-trips through readJsonStateArtifact without tmp residue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "state.json");
    const state = { count: { value: 3 }, flag: true, list: [1, "two"] };

    await writeJsonStateArtifact(target, state);

    await expect(readJsonStateArtifact(target)).resolves.toEqual(state);
    await expect(readJsonStateArtifact(join(dir, "missing.json"))).resolves.toEqual({});
    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("atomicWriteJson serializes concurrent writes to one target and leaves no tmp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "track.json");
    await atomicWriteJson(target, { writer: 0 });

    // Overlapping replace-renames of one target fail with EPERM on Windows;
    // the writes must be serialized so every caller succeeds and exactly one
    // complete document remains.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => atomicWriteJson(target, { writer: index + 1 })),
    );

    await expect(readJsonStateArtifact(target)).resolves.toEqual({
      writer: expect.any(Number),
    });
    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("atomicWriteJson succeeds while a reader briefly holds the target open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-open-"));
    const target = join(dir, "answer.json");
    await atomicWriteJson(target, { round: 0 });

    // On Windows a replace-rename fails with EPERM while any other handle has
    // the target open. The runtime's wait poller and the dashboard both read
    // the answer file while it is being written, so the write has to survive a
    // concurrent reader instead of failing the whole command.
    const handle = await open(target, "r");
    const write = atomicWriteJson(target, { round: 1 });
    // The reader releases the file once its read completes.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await handle.close();

    await expect(write).resolves.toBeUndefined();
    await expect(readJsonStateArtifact(target)).resolves.toEqual({ round: 1 });
    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("readRunEventsSince returns complete event lines and advances the cursor", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const firstEvent = makeEvent("workflow.started");
    const secondEvent = makeEvent("step.started");
    const expectedContents = `${JSON.stringify(firstEvent)}\n${JSON.stringify(secondEvent)}\n`;
    await writeFile(eventsFile, expectedContents, "utf8");

    const first = await readRunEventsSince(eventsFile, 0);
    expect(first.entries.map((entry) => entry.event.type)).toEqual([
      "workflow.started",
      "step.started",
    ]);
    expect(first.offset).toBe(Buffer.byteLength(expectedContents, "utf8"));

    const second = await readRunEventsSince(eventsFile, first.offset);
    expect(second.entries).toEqual([]);
    expect(second.offset).toBe(first.offset);
  });

  it("readRunEventsSince short-circuits when the trail has not grown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const contents = `${JSON.stringify(makeEvent("workflow.started"))}\n`;
    await writeFile(eventsFile, contents, "utf8");

    const size = Buffer.byteLength(contents, "utf8");
    const read = await readRunEventsSince(eventsFile, size);

    // No new bytes: nothing to parse and no full-file text, which is the
    // observable contract that keeps a 50 ms long-poll off the whole trail.
    expect(read.entries).toEqual([]);
    expect(read.offset).toBe(size);
    expect(read.text).toBe("");
  });

  it("readRunEventsSince restarts from 0 when the cursor is past the file size", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const contents = `${JSON.stringify(makeEvent("workflow.started"))}\n`;
    await writeFile(eventsFile, contents, "utf8");

    const read = await readRunEventsSince(eventsFile, 10_000);

    expect(read.entries.map((entry) => entry.event.type)).toEqual(["workflow.started"]);
    expect(read.offset).toBe(Buffer.byteLength(contents, "utf8"));
  });

  it("readRunEventsSince leaves a partial trailing line for the next read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const firstEvent = makeEvent("workflow.started");
    await writeFile(eventsFile, `${JSON.stringify(firstEvent)}\n{"partial"`, "utf8");

    const read = await readRunEventsSince(eventsFile, 0);
    expect(read.entries.map((entry) => entry.event.type)).toEqual(["workflow.started"]);
    expect(read.offset).toBe(Buffer.byteLength(`${JSON.stringify(firstEvent)}\n`, "utf8"));
  });

  it("readRunEventsSince reports and skips malformed or non-event lines", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    await writeFile(
      eventsFile,
      `${JSON.stringify(makeEvent("workflow.started"))}\n${JSON.stringify({ hello: "world" })}\n{not json}\n${JSON.stringify(makeEvent("step.started"))}\n`,
      "utf8",
    );

    const errors: string[] = [];
    const read = await readRunEventsSince(eventsFile, 0, {
      report: (message) => errors.push(message),
    });

    expect(read.entries.map((entry) => entry.event.type)).toEqual([
      "workflow.started",
      "step.started",
    ]);
    expect(errors.join("\n")).toContain("Unexpected event shape");
    expect(errors.join("\n")).toContain("Unable to parse event JSONL");
  });
});

function makeEvent(type: Event["type"]): Event {
  return {
    id: `evt_${type}`,
    runId: "run-storage-test",
    workflowId: "workflow-storage-test",
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
  };
}
