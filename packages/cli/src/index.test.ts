import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "./index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("main", () => {
  it("prints discovered workflow ids for the list command", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", task.id);
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
      "export const reviewFeature = { id: 'reviewFeature', inputShape: { task: 'string' }, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["list"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual(["@acme/stepkit-workflows:reviewFeature"]);
    expect(errors).toEqual([]);
  });

  it("runs a discovered continuation workflow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-run`);
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
      "export const reviewFeature = { id: 'reviewFeature', inputShape: { ok: 'boolean' }, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];
    const events: unknown[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:reviewFeature", "run-001", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        eventSink: (event) => {
          events.push(event);
        },
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toContain("Workflow completed: @acme/stepkit-workflows:reviewFeature");
    expect(errors).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ payload: { input: { ok: true } } }));
  });

  it("run loads .stepkit/config.json and passes it to runWorkflow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-config-run`);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: { "@acme/stepkit-workflows": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      version: 1,
      customAgents: {
        local: { binary: "local-agent", args: ["{{promptFile}}", "{{outputFile}}"] },
      },
      workingAgents: { small: [{ provider: "local", model: "fake-model" }] },
      interactiveAgents: {},
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
      [
        "import { done, step } from '@stepkit/core';",
        "export const reviewFeature = {",
        "  id: 'reviewFeature',",
        "  inputShape: { ok: 'boolean' },",
        "  outputShape: { answer: 'string' },",
        "  agents: { builder: { size: 'small' } },",
        "  start: () => step({ id: 'delegate', outputShape: { answer: 'string' }, agent: 'builder' }).prompt('answer from configured agent').next(done)({})",
        "};",
      ].join("\n"),
      "utf8",
    );
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:reviewFeature", "run-001", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        workingAgentProcessRunner: async (request) => {
          requests.push(request);
          await writeFile(request.outputFile, JSON.stringify({ answer: "from config" }), "utf8");
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "local-agent",
      args: [expect.stringContaining("prompt.md"), expect.stringContaining("output.json")],
      model: "fake-model",
      shell: false,
    });
  });

  it("run fails clearly when a configured working agent is needed but .stepkit/config.json is missing", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-main-tests",
      `${task.id}-missing-config-agent-run`,
    );
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
      [
        "import { done, step } from '@stepkit/core';",
        "export const reviewFeature = {",
        "  id: 'reviewFeature',",
        "  inputShape: { ok: 'boolean' },",
        "  outputShape: { answer: 'string' },",
        "  agents: { builder: { size: 'small' } },",
        "  start: () => step({ id: 'delegate', outputShape: { answer: 'string' }, agent: 'builder' }).prompt('answer from configured agent').next(done)({})",
        "};",
      ].join("\n"),
      "utf8",
    );
    const errors: string[] = [];
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:reviewFeature", "run-001", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        workingAgentProcessRunner: async (request) => {
          requests.push(request);
          throw new Error("working agent runner should not be called without config");
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(errors.join("\n")).toMatch(/missing \.stepkit\/config\.json/i);
    expect(errors.join("\n")).toMatch(/agent 'builder'/i);
  });

  it("malformed .stepkit/config.json reports a CLI input error", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-malformed-config`);
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeFile(join(cwd, ".stepkit", "config.json"), "{", "utf8");
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:reviewFeature", "run-001", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/invalid \.stepkit\/config\.json/i);
  });

  it("invalid .stepkit/config.json schema reports a CLI input error", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-invalid-config-schema`);
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      version: 1,
      customAgents: {},
      workingAgents: { tiny: [{ provider: "missing-command" }] },
      interactiveAgents: {},
    });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:reviewFeature", "run-001", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/invalid \.stepkit\/config\.json/i);
    expect(errors.join("\n")).toMatch(/missing-command/i);
  });

  it("list does not require .stepkit/config.json", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-list-without-config`);
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
    await writeFile(join(packageDir, "index.mjs"), "export {};", "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["list"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("prints clean errors for invalid JSON before a run starts", async () => {
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/stepkit-workflows:reviewFeature", "run-001", "--input", "{"],
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/invalid JSON/i);
  });
});
