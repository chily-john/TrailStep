import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

async function writeRetryWorkflow(cwd: string): Promise<void> {
  await writeFile(
    join(cwd, "workflow.mjs"),
    `import { access } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { document, done, step } from '@stepkit/core';
    const workflowDir = dirname(fileURLToPath(import.meta.url));
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value, label) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
        throw new Error(label + ' must be an object');
      },
    };
    export const retryFeature = {
      id: 'retryFeature',
      input: schema,
      output: schema,
      start: (input) => step({ id: 'review' }).do(async (stepInput) => {
        let fixed = true;
        try {
          await access(join(workflowDir, 'fixed.txt'));
        } catch {
          fixed = false;
        }
        await document(fixed ? 'retried attempt' : 'failed attempt');
        if (!fixed) {
          throw new Error('review unavailable');
        }
        return done({ ...stepInput, reviewed: true });
      })(input),
    };`,
    "utf8",
  );
}

function parseEvents(jsonl: string): readonly { type: string; payload: Record<string, unknown> }[] {
  return jsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
}

describe("retry command", () => {
  it("fails safely with no target in non-interactive mode", async () => {
    const errors: string[] = [];

    await expect(
      main({
        argv: ["retry"],
        prompts: undefined,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/explicit retry target|required/i);
  });

  it("exits cleanly when no eligible failed runs exist", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-retry-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    const lines: string[] = [];

    await expect(
      main({
        argv: ["retry"],
        cwd,
        prompts: { text: async () => "", select: async () => "" },
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toMatch(/No eligible failed runs found/i);
  });

  it("prompts to select and confirm an eligible failed run when retry has no arguments", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-retry-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    await writeRetryWorkflow(cwd);
    const errors: string[] = [];

    for (const runName of ["failed-alpha", "failed-beta"]) {
      await expect(
        main({
          argv: ["./workflow.mjs#retryFeature", runName, "--input", "{}"],
          cwd,
          io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        }),
      ).resolves.toBe(1);
    }

    await writeFile(join(cwd, "fixed.txt"), "fixed\n", "utf8");
    await expect(
      main({
        argv: ["./workflow.mjs#retryFeature", "completed-run", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    const selectCalls: { prompt: string; choices: readonly string[] }[] = [];
    const lines: string[] = [];

    await expect(
      main({
        argv: ["retry"],
        cwd,
        prompts: {
          text: async () => "./workflow.mjs#retryFeature",
          select: async (prompt, choices) => {
            selectCalls.push({ prompt, choices });
            if (prompt.includes("confirm") || prompt.includes("Retry run")) {
              return "yes";
            }
            return choices.find((choice) => choice.includes("failed-beta")) ?? choices[0] ?? "";
          },
        },
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(selectCalls[0]).toMatchObject({ prompt: "Select a failed run to retry" });
    expect(selectCalls[0]?.choices).toHaveLength(2);
    expect(selectCalls[0]?.choices.join("\n")).toContain("failed-alpha");
    expect(selectCalls[0]?.choices.join("\n")).toContain("failed-beta");
    expect(selectCalls[0]?.choices.join("\n")).not.toContain("completed-run");
    expect(selectCalls[0]?.choices.join("\n")).toMatch(/retryFeature.*latest.*step review.*review unavailable/);
    expect(selectCalls[1]).toMatchObject({ prompt: "Retry run failed-beta for workflow retryFeature?" });

    const events = parseEvents(
      await readFile(join(cwd, ".stepkit", "runs", "failed-beta", "events.jsonl"), "utf8"),
    );
    expect(events.map((event) => event.type)).toContain("workflow.retryStarted");
    expect(lines.join("\n")).toContain(join(cwd, ".stepkit", "runs", "failed-beta"));
  });

  it("retries an explicitly targeted failed run and preserves failed attempt artifacts", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-retry-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    await writeRetryWorkflow(cwd);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["./workflow.mjs#retryFeature", "retry-me", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    const runDir = join(cwd, ".stepkit", "runs", "retry-me");
    const failedStepDir = join(runDir, "steps", "0001-review");
    expect((await stat(failedStepDir)).isDirectory()).toBe(true);
    await expect(readFile(join(failedStepDir, "document-1.md"), "utf8")).resolves.toBe(
      "failed attempt",
    );

    await writeFile(join(cwd, "fixed.txt"), "fixed\n", "utf8");
    const lines: string[] = [];

    await expect(
      main({
        argv: ["retry", "./workflow.mjs#retryFeature", "retry-me"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    const retriedStepDir = join(runDir, "steps", "0002-review");
    const events = parseEvents(await readFile(join(runDir, "events.jsonl"), "utf8"));

    expect(events.map((event) => event.type)).toContain("workflow.retryStarted");
    expect(events.find((event) => event.type === "workflow.retryStarted")?.payload).toMatchObject({
      retryKind: "manual",
      sourceFailureEventId: expect.any(String),
      sourceFailureReplayPosition: expect.any(Number),
    });
    await expect(readFile(join(failedStepDir, "document-1.md"), "utf8")).resolves.toBe(
      "failed attempt",
    );
    await expect(readFile(join(retriedStepDir, "document-1.md"), "utf8")).resolves.toBe(
      "retried attempt",
    );
    await expect(stat(join(cwd, ".stepkit", "runs", "retry-me-2"))).rejects.toThrow();
    expect(lines.join("\n")).toContain(runDir);
  });
});
