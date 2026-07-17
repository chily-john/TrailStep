import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeWorkflowPackage(cwd: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(cwd, "package.json"), {
    name: "consumer",
    dependencies: { "@acme/stepkit-workflows": "1.0.0" },
  });
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/stepkit-workflows",
    version: "1.0.0",
    type: "module",
    main: "./index.mjs",
    keywords: ["stepkit-workflow"],
  });
  await writeFile(
    join(packageDir, "index.mjs"),
    `import { done, step } from '@stepkit/core';
    let shouldFailResumeFeature = true;
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value, label) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
        throw new Error(label + ' must be an object');
      },
    };
    export const reviewFeature = {
      id: 'reviewFeature',
      input: schema,
      output: schema,
      start: (input) => step({
        id: 'prepare',
        outputShape: schema,
      }).next((stepInput) => done({ ...stepInput, prepared: true }))(input),
    };
    export const resumeFeature = {
      id: 'resumeFeature',
      input: schema,
      output: schema,
      start: (input) => {
        const finishStep = step({
          id: 'finish',
          outputShape: schema,
        }).next((stepInput) => {
          if (shouldFailResumeFeature) {
            shouldFailResumeFeature = false;
            throw new Error('finish unavailable');
          }
          return done({ ...stepInput, finished: true });
        });

        const prepareStep = step({
          id: 'prepare',
          outputShape: schema,
        }).next((stepInput) => finishStep({ ...stepInput, prepared: true }));

        return prepareStep(input);
      },
    };`,
    "utf8",
  );
}

describe("run command", () => {
  it("runs a discovered workflow and creates a numbered run directory when the requested name already exists", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeWorkflowPackage(cwd);
    await mkdir(join(cwd, ".stepkit", "runs", "my-run"), { recursive: true });
    await writeJson(join(cwd, "input.json"), { ok: true });
    const lines: string[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:reviewFeature", "my-run", "--input-file", "input.json"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const runDir = join(cwd, ".stepkit", "runs", "my-run-2");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      '"prepared":true',
    );
    expect(lines.join("\n")).toContain("@acme/stepkit-workflows:reviewFeature");
    expect(lines.join("\n")).toContain(runDir);
  });

  it("passes resume runDir to core for an existing failed run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeWorkflowPackage(cwd);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:resumeFeature", "resume-run", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    const runDir = join(cwd, ".stepkit", "runs", "resume-run");
    const lines: string[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:resumeFeature", "resume-run", "--resume"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const eventsJsonl = await readFile(join(runDir, "events.jsonl"), "utf8");
    expect(eventsJsonl).toContain("workflow.resumed");
    expect(eventsJsonl).toContain('"finished":true');
    await expect(
      readFile(join(cwd, ".stepkit", "runs", "resume-run-2", "events.jsonl"), "utf8"),
    ).rejects.toThrow();
    expect(lines.join("\n")).toContain(runDir);
  });

  it("fails with a list suggestion when the package-qualified workflow id is unknown", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeWorkflowPackage(cwd);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:missing", "my-run", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/workflow.*not found/i);
    expect(errors.join("\n")).toContain("stepkit list");
  });
});
