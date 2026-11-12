import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "./index.js";

const TEST_ROOT = join("node_modules", ".tmp-trailstep-reserved-run-error-tests");

async function makeProject(testId: string): Promise<string> {
  const cwd = join(TEST_ROOT, testId);
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(join(cwd, ".git"), { recursive: true });
  await writeFile(
    join(cwd, "workflow.mjs"),
    "export const reservedDemo = { id: 'reservedDemo', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };\n",
    "utf8",
  );
  return cwd;
}

function expectCleanReservedError(errors: readonly string[]): void {
  const output = errors.join("\n");
  expect(output).toMatch(/reserved for TrailStep storage infrastructure/i);
  expect(output).not.toMatch(/fatal/i);
  expect(output).not.toMatch(/\n\s+at /u);
}

function expectCleanInvalidError(errors: readonly string[]): void {
  const output = errors.join("\n");
  expect(output).toMatch(/single path segment/i);
  expect(output).not.toMatch(/fatal/i);
  expect(output).not.toMatch(/\n\s+at /u);
}

describe("reserved run identifier rendering", () => {
  it("prints a clean message for creation", async ({ task }) => {
    const cwd = await makeProject(`${task.id}-create`);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["./workflow.mjs", ".staging", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expectCleanReservedError(errors);
    await expect(stat(join(cwd, ".trailstep", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints a clean message for retry", async ({ task }) => {
    const cwd = await makeProject(`${task.id}-retry`);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["retry", "./workflow.mjs#reservedDemo", ".staging"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expectCleanReservedError(errors);
    await expect(stat(join(cwd, ".trailstep", "runs", ".staging"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prints a clean message for cancel by archived path", async ({ task }) => {
    const cwd = await makeProject(`${task.id}-cancel`);
    const archivedRun = join(cwd, ".trailstep", "runs", ".archive", "archived-run");
    await mkdir(archivedRun, { recursive: true });
    const eventsPath = join(archivedRun, "events.jsonl");
    await writeFile(eventsPath, "", "utf8");
    const errors: string[] = [];

    await expect(
      main({
        argv: ["cancel", archivedRun],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expectCleanReservedError(errors);
    await expect(readFile(eventsPath, "utf8")).resolves.toBe("");
  });

  it("read-only archived-path inspection never makes cancel, answer or retry mutable", async ({
    task,
  }) => {
    const cwd = await makeProject(`${task.id}-readonly`);
    const archivedRun = join(cwd, ".trailstep", "runs", ".archive", "archived-run");
    await mkdir(archivedRun, { recursive: true });
    const eventsPath = join(archivedRun, "events.jsonl");
    const originalEvents = '{"type":"workflow.started","payload":{}}\n';
    await writeFile(eventsPath, originalEvents, "utf8");
    const errors: string[] = [];
    const io = { writeLine: () => undefined, writeError: (line: string) => errors.push(line) };

    for (const argv of [
      ["cancel", archivedRun],
      ["answer", archivedRun, "approval", "--json", "{}"],
      ["retry", "./workflow.mjs#reservedDemo", archivedRun],
    ]) {
      await expect(main({ argv, cwd, io })).resolves.toBe(1);
    }

    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error).toMatch(/reserved for TrailStep storage infrastructure/i);
    }
    await expect(readFile(eventsPath, "utf8")).resolves.toBe(originalEvents);
  });

  it("prints a clean message for a storage operation", async ({ task }) => {
    const cwd = await makeProject(`${task.id}-storage`);
    const stagingDir = join(cwd, ".trailstep", "runs", ".staging");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "keep.txt"), "staged", "utf8");
    const errors: string[] = [];

    await expect(
      main({
        argv: ["storage", "delete", ".staging"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expectCleanReservedError(errors);
    await expect(readFile(join(stagingDir, "keep.txt"), "utf8")).resolves.toBe("staged");
  });

  it("prints a clean message for an invalid run name", async ({ task }) => {
    const cwd = await makeProject(`${task.id}-invalid`);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["./workflow.mjs", "nested/name", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expectCleanInvalidError(errors);
    await expect(stat(join(cwd, ".trailstep", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
