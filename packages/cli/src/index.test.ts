import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      customProviders: {
        local: { binary: "local-agent", args: ["{{promptFile}}", "{{outputFile}}"] },
      },
      agents: { small: { items: [{ provider: "local", model: "fake-model" }] } },
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
      customProviders: {},
      agents: { tiny: { items: [{ provider: "missing-command" }] } },
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

  it("runs representative README-compatible workflow refs", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-readme-flows`);
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: { "@acme/workflows": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "export const review = { id: 'review', inputShape: { ok: 'boolean' }, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.0.0",
      type: "module",
      main: "./index.mjs",
      stepkit: { workflows: { release: "./index.mjs#release" } },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "export const release = { id: 'release', inputShape: { ok: 'boolean' }, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    const errors: string[] = [];

    const run = async (argv: string[]) => {
      const lines: string[] = [];
      await expect(
        main({
          argv,
          cwd,
          io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
          runNameClock: () => new Date("2026-01-02T03:04:05.000Z"),
          runNameRandomSuffix: () => "abc123",
        }),
      ).resolves.toBe(0);
      return lines.join("\n");
    };

    await expect(
      run(["./workflows/review.mjs", "direct-run", "--input", '{"ok":true}']),
    ).resolves.toMatch(/Workflow completed: .*review\.mjs/);
    await expect(run(["./workflows/review.mjs", "--input", '{"ok":true}'])).resolves.toContain(
      join(".stepkit", "runs", "review-20260102-030405-abc123"),
    );
    await expect(
      run(["project/review", "project-run", "--input", '{"ok":true}']),
    ).resolves.toContain("Workflow completed: project/review");
    await expect(
      run(["@acme/workflows#release", "bundle-run", "--input", '{"ok":true}']),
    ).resolves.toContain("Workflow completed: @acme/workflows#release");
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

  it("doctor reports a clean deprecation scan for registered workflow packages", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-doctor-clean`);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/sdk": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "@acme/stepkit-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/stepkit-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { defineWorkflow } from '@stepkit/sdk';\nexport const review = defineWorkflow;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedSdkSymbol],
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toMatch(/no StepKit deprecation findings/i);
    expect(errors).toEqual([]);
  });

  it("doctor excludes direct-file registered workflows from the deprecation scan", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-doctor-direct-file`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/sdk": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { removedStep } from '@stepkit/sdk';\nexport const review = removedStep;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    // Direct-file registered workflows have no npm version and are excluded from deprecation
    // scan targets entirely (per design), so even a symbol that would otherwise be blocking
    // produces no finding here.
    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedSdkSymbol],
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toMatch(/no StepKit deprecation findings/i);
    expect(errors).toEqual([]);
  });

  it("doctor reports warning deprecations without blocking", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-doctor-warning`);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/sdk": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "@acme/stepkit-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/stepkit-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { oldStep } from '@stepkit/sdk';\nexport const review = oldStep;\n",
      "utf8",
    );
    const lines: string[] = [];

    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        deprecationManifest: [{ ...removedSdkSymbol, symbol: "oldStep", removedIn: undefined }],
      }),
    ).resolves.toBe(1);

    expect(lines.join("\n")).toContain("warning @stepkit/sdk/oldStep");
  });

  it("doctor returns a blocking result for removed symbols", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-doctor-blocking`);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/sdk": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "@acme/stepkit-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/stepkit-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep } from '@stepkit/sdk';\nexport const review = removedStep;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedSdkSymbol],
      }),
    ).resolves.toBe(2);

    expect(lines.join("\n")).toContain("blocking @stepkit/sdk/removedStep");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
  });

  it("doctor does not detect aliased imports (known limitation)", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-doctor-aliased`);
    const packageDir = join(cwd, "node_modules", "@acme", "stepkit-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/sdk": "1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "@acme/stepkit-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/stepkit-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep as rs } from '@stepkit/sdk';\nexport const review = rs;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    // The scanner is text/regex-based, not a type-checker: once a symbol is imported under an
    // alias, its usage is under the new local name, and the scanner deliberately does not track
    // aliases through to their usage sites. Neither "removedStep" nor "rs" should match.
    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedSdkSymbol],
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toMatch(/no StepKit deprecation findings/i);
    expect(errors).toEqual([]);
  });

  it("update workflows-only leaves StepKit package entries unchanged", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-update-workflows`);
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeJson(packageJsonPath, { dependencies: { "@stepkit/core": "^1.0.0" } });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "@acme/workflows#review" } },
    });

    await expect(
      main({
        argv: ["update", "--workflows", "--yes"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async () => ({ exitCode: 0, stdout: "[]" }),
      }),
    ).resolves.toBe(0);

    expect(await readFile(packageJsonPath, "utf8")).toContain('"@stepkit/core": "^1.0.0"');
  });

  it("update --all prints direct-file skips and excludes that file from the deprecation scan", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-update-all-direct`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "^1.0.0", "@stepkit/sdk": "^1.0.0" },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { oldStep } from '@stepkit/sdk';\nexport const review = oldStep;\n",
      "utf8",
    );
    const lines: string[] = [];

    await expect(
      main({
        argv: ["update", "--all", "--yes"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        packageCommandRunner: latestStepkitTwo,
        deprecationManifest: [{ ...removedSdkSymbol, symbol: "oldStep", removedIn: undefined }],
      }),
    ).resolves.toBe(0);

    // Direct-file registered workflows have no npm version, so they are excluded from
    // deprecation scan targets entirely — the skip message still comes from update's own,
    // separate skipped-direct-file reporting, but no finding is produced for its source text.
    expect(lines.join("\n")).toContain("Skipped project/review: local file source");
    expect(lines.join("\n")).not.toContain("warning @stepkit/sdk/oldStep");
    expect(lines.join("\n")).not.toContain("workflows/review.mjs");
  });

  it("update self-update uses the detected package manager from main()", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-main-tests", `${task.id}-update-pm`);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "yarn.lock"), "", "utf8");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@stepkit/core": "^1.0.0" },
    });
    const installRequests: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

    await expect(
      main({
        argv: ["update", "--yes"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async (request) => {
          if (request.args[0] === "install") {
            installRequests.push(request);
            return { exitCode: 0 };
          }
          return latestStepkitTwo(request);
        },
      }),
    ).resolves.toBe(0);

    expect(installRequests).toEqual([{ command: "yarn", args: ["install"], cwd }]);
  });
});

const removedSdkSymbol = {
  packageName: "@stepkit/sdk",
  symbol: "removedStep",
  deprecatedSince: "0.5.0",
  removedIn: "1.0.0",
  message: "removedStep was removed.",
  replacement: "step",
};

async function latestStepkitTwo(request: { readonly args: readonly string[] }) {
  const metadata: Record<string, unknown> = {
    "@stepkit/core": [{ version: "2.0.0" }],
    "@stepkit/sdk": [{ version: "2.0.0", peerDependencies: { "@stepkit/core": "^2.0.0" } }],
    "@stepkit/cli": [{ version: "2.0.0", peerDependencies: { "@stepkit/core": "^2.0.0" } }],
  };
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
}
