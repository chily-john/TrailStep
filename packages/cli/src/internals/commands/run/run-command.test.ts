import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeDirectWorkflowFile(cwd: string): Promise<void> {
  const workflowDir = join(cwd, "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "review.mjs"),
    `import { done, step } from '@trailstep/core';
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value, label) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
        throw new Error(label + ' must be an object');
      },
    };
    export default {
      id: 'review',
      input: schema,
      output: schema,
      start: (input) => step({ id: 'prepare' })
        .do((stepInput) => done({ ...stepInput, prepared: true }))(input),
    };`,
    "utf8",
  );
}

async function writeAmbiguousDirectWorkflowFile(cwd: string): Promise<void> {
  const workflowDir = join(cwd, "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "ambiguous.mjs"),
    `const schema = {
      validate: () => true,
      diagnostics: () => [],
      assert: (value) => value,
    };
    export const review = {
      id: 'review',
      inputShape: schema,
      start: (input) => ({ kind: 'done', output: input }),
    };
    export const cleanup = {
      id: 'cleanup',
      inputShape: schema,
      start: (input) => ({ kind: 'done', output: input }),
    };`,
    "utf8",
  );
}

async function writeRegisteredProjectWorkflow(cwd: string): Promise<void> {
  const workflowDir = join(cwd, ".trailstep", "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeJson(join(cwd, ".trailstep", "config.json"), {
    version: 1,
    customProviders: {
      local: { binary: "pi" },
    },
    agents: {},
    workflows: {
      project: {
        release: "./.trailstep/workflows/release.mjs",
      },
      review: {
        agents: {
          reviewer: [{ provider: "local" }],
        },
      },
    },
  });
  await writeRegisteredWorkflowFile(workflowDir, "release", { released: true });
}

async function writeRegisteredWorkflowFile(
  workflowDir: string,
  workflowName: string,
  output: Record<string, boolean>,
): Promise<void> {
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, `${workflowName}.mjs`),
    `import { done, step } from '@trailstep/core';
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value, label) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
        throw new Error(label + ' must be an object');
      },
    };
    export const ${workflowName} = {
      id: '${workflowName}',
      input: schema,
      output: schema,
      start: (input) => step({ id: 'prepare' })
        .do((stepInput) => done({ ...stepInput, ...${JSON.stringify(output)} }))(input),
    };`,
    "utf8",
  );
}

async function writeConflictingRegisteredWorkflows(cwd: string, homeDir: string): Promise<void> {
  await writeJson(join(cwd, ".trailstep", "config.json"), {
    workflows: {
      project: {
        review: "./.trailstep/workflows/review.mjs",
      },
    },
  });
  await writeJson(join(homeDir, ".trailstep", "config.json"), {
    workflows: {
      global: {
        review: "~/.trailstep/workflows/review.mjs",
      },
    },
  });
  await writeRegisteredWorkflowFile(join(cwd, ".trailstep", "workflows"), "review", {
    projectSelected: true,
  });
  await writeRegisteredWorkflowFile(join(homeDir, ".trailstep", "workflows"), "review", {
    userSelected: true,
  });
}

async function writeBundleWorkflowPackage(cwd: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "workflows");
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(cwd, "package.json"), {
    name: "consumer",
    dependencies: { "@acme/workflows": "1.0.0" },
  });
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/workflows",
    version: "1.0.0",
    type: "module",
    trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
  });
  await writeFile(
    join(packageDir, "index.mjs"),
    `import { done, step } from '@trailstep/core';
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value, label) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
        throw new Error(label + ' must be an object');
      },
    };
    export const reviewWorkflow = {
      id: 'reviewWorkflow',
      input: schema,
      output: schema,
      start: (input) => step({ id: 'prepare' })
        .do((stepInput) => done({ ...stepInput, prepared: true }))(input),
    };`,
    "utf8",
  );
}

async function writeWorkflowPackage(cwd: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(cwd, "package.json"), {
    name: "consumer",
    dependencies: { "@acme/trailstep-workflows": "1.0.0" },
  });
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/trailstep-workflows",
    version: "1.0.0",
    type: "module",
    main: "./index.mjs",
    keywords: ["trailstep-workflow"],
  });
  await writeFile(
    join(packageDir, "index.mjs"),
    `import { done, step } from '@trailstep/core';
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
      }).do((stepInput) => done({ ...stepInput, prepared: true }))(input),
    };`,
    "utf8",
  );
}

describe("run command", () => {
  it("runs a directly referenced workflow file without a run name and writes events", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeDirectWorkflowFile(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["./workflows/review.mjs", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        runNameClock: () => new Date("2026-07-17T15:30:45.000Z"),
        runNameRandomSuffix: () => "abc123",
      }),
    ).resolves.toBe(0);

    const runDir = join(cwd, ".trailstep", "runs", "review-20260717-153045-abc123");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      '"prepared":true',
    );
    expect(lines.join("\n")).toContain(resolve(cwd, "workflows", "review.mjs"));
    expect(lines.join("\n")).toContain(runDir);
  });

  it("runs a directly referenced workflow file into TRAILSTEP_RUNS_ROOT", async ({ task }) => {
    const root = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    const cwd = join(root, "worktree");
    const runsRoot = resolve(root, "source", ".trailstep", "runs");
    await rm(root, { recursive: true, force: true });
    await writeDirectWorkflowFile(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["./workflows/review.mjs", "central-run", "--input", '{"ok":true}'],
        cwd,
        env: { TRAILSTEP_RUNS_ROOT: runsRoot },
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const runDir = join(runsRoot, "central-run");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    await expect(stat(join(cwd, ".trailstep", "runs"))).rejects.toThrow();
    expect(lines.join("\n")).toContain(runDir);
  });

  it("ignores the legacy STEPKIT_RUNS_ROOT override", async ({ task }) => {
    const root = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    const cwd = join(root, "worktree");
    const legacyRunsRoot = resolve(root, "legacy", ".stepkit", "runs");
    await rm(root, { recursive: true, force: true });
    await writeDirectWorkflowFile(cwd);

    await expect(
      main({
        argv: ["./workflows/review.mjs", "default-run", "--input", '{"ok":true}'],
        cwd,
        env: { STEPKIT_RUNS_ROOT: legacyRunsRoot },
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(
      readFile(join(cwd, ".trailstep", "runs", "default-run", "events.jsonl"), "utf8"),
    ).resolves.toContain("workflow.completed");
    await expect(stat(legacyRunsRoot)).rejects.toThrow();
  });

  it("runs a directly referenced workflow file with an explicit run name", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeDirectWorkflowFile(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["./workflows/review.mjs", "run-one", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const runDir = join(cwd, ".trailstep", "runs", "run-one");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    expect(lines.join("\n")).toContain(runDir);
  });

  it("fails clearly for a missing directly referenced workflow file", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["./workflows/missing.mjs", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/Direct workflow file not found:/);
  });

  it("fails direct workflow files with multiple valid exports before creating a run directory", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeAmbiguousDirectWorkflowFile(cwd);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["./workflows/ambiguous.mjs", "ambiguous-run", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/path#exportName.*bulk add/i);
    expect(errors.join("\n")).toMatch(/Available workflow exports: cleanup, review/i);
    await expect(stat(join(cwd, ".trailstep", "runs", "ambiguous-run"))).rejects.toThrow();
  });

  it("runs a project-registered workflow from .trailstep/config.json", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeRegisteredProjectWorkflow(cwd);
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["project/release", "--input", '{"ok":true}'],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      runNameClock: () => new Date("2026-07-17T15:30:45.000Z"),
      runNameRandomSuffix: () => "abc123",
    });
    expect({ errors, exitCode }).toEqual({ errors: [], exitCode: 0 });

    const runDir = join(cwd, ".trailstep", "runs", "release-20260717-153045-abc123");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      '"released":true',
    );
    expect(lines.join("\n")).toContain("project/release");
    expect(lines.join("\n")).toContain(runDir);
  });

  it("runs an unqualified project-registered workflow from .trailstep/config.json", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeRegisteredProjectWorkflow(cwd);
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["release", "--input", "{}"],
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });
    expect({ errors, exitCode }).toEqual({ errors: [], exitCode: 0 });
  });

  it("prefers project registrations for unqualified conflicts while explicit global refs remain available", async ({
    task,
  }) => {
    const root = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    const cwd = join(root, "project");
    const homeDir = join(root, "home");
    await rm(root, { recursive: true, force: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(homeDir, ".trailstep"), { recursive: true });
    await writeConflictingRegisteredWorkflows(cwd, homeDir);
    const projectLines: string[] = [];
    const userLines: string[] = [];

    await expect(
      main({
        argv: ["review", "project-run", "--input", "{}"],
        cwd,
        homeDir,
        io: { writeLine: (line) => projectLines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);
    await expect(
      main({
        argv: ["global/review", "user-run", "--input", "{}"],
        cwd,
        homeDir,
        io: { writeLine: (line) => userLines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(
      readFile(join(cwd, ".trailstep", "runs", "project-run", "events.jsonl"), "utf8"),
    ).resolves.toContain('"projectSelected":true');
    await expect(
      readFile(join(cwd, ".trailstep", "runs", "user-run", "events.jsonl"), "utf8"),
    ).resolves.toContain('"userSelected":true');
    expect(projectLines.join("\n")).toContain("project/review");
    expect(userLines.join("\n")).toContain("global/review");
  });

  it("runs a workflow from scoped package bundle manifest metadata", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeBundleWorkflowPackage(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["@acme/workflows#review", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        runNameClock: () => new Date("2026-07-17T15:30:45.000Z"),
        runNameRandomSuffix: () => "abc123",
      }),
    ).resolves.toBe(0);

    const runDir = join(cwd, ".trailstep", "runs", "review-workflow-20260717-153045-abc123");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      '"prepared":true',
    );
    expect(lines.join("\n")).toContain("@acme/workflows#review");
    expect(lines.join("\n")).toContain(runDir);
  });

  it("runs a discovered workflow without a run name and creates a generated run directory", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeWorkflowPackage(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        runNameClock: () => new Date("2026-07-17T15:30:45.000Z"),
        runNameRandomSuffix: () => "abc123",
      }),
    ).resolves.toBe(0);

    const runDir = join(cwd, ".trailstep", "runs", "review-feature-20260717-153045-abc123");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      '"prepared":true',
    );
    expect(lines.join("\n")).toContain(runDir);
  });

  it("runs a discovered workflow and creates a numbered run directory when the requested name already exists", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeWorkflowPackage(cwd);
    await mkdir(join(cwd, ".trailstep", "runs", "my-run"), { recursive: true });
    await writeJson(join(cwd, "input.json"), { ok: true });
    const lines: string[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "my-run", "--input-file", "input.json"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const runDir = join(cwd, ".trailstep", "runs", "my-run-2");
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      "workflow.completed",
    );
    await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toContain(
      '"prepared":true',
    );
    expect(lines.join("\n")).toContain("@acme/trailstep-workflows:reviewFeature");
    expect(lines.join("\n")).toContain(runDir);
  });

  it("rejects legacy resume syntax and points users to retry", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-run-command-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "resume-run", "--resume"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/trailstep retry <workflow-ref> <runName>/i);
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
        argv: ["@acme/trailstep-workflows:missing", "my-run", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/workflow.*not found/i);
    expect(errors.join("\n")).toContain("trailstep workflows");
  });
});
