import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "./index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readCliPackageJson(): Promise<{ bin?: Record<string, string> }> {
  return JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
}

async function writeDirectWorkflowFile(cwd: string): Promise<void> {
  const workflowDir = join(cwd, "workflows");
  const coreImportUrl = pathToFileURL(resolve("..", "core", "dist", "index.js")).href;
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "review.mjs"),
    `import { done, step } from '${coreImportUrl}';

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

async function writeContinuationWorkflowPackage(cwd: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "trailstep-continuation-workflows");
  const coreImportUrl = pathToFileURL(resolve("..", "core", "dist", "index.js")).href;
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(cwd, "package.json"), {
    name: "consumer",
    dependencies: { "@acme/trailstep-continuation-workflows": "1.0.0" },
  });
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/trailstep-continuation-workflows",
    version: "1.0.0",
    type: "module",
    main: "./index.mjs",
    keywords: ["trailstep-workflow"],
  });
  await writeFile(
    join(packageDir, "index.mjs"),
    `import { done, shape, step } from '${coreImportUrl}';

    const defineWorkflow = (options) => options;
    const taskShape = shape({ task: 'string' });
    const summaryShape = shape({ task: 'string', summary: 'string' });

    export const simpleWorkflow = defineWorkflow({
      id: 'simpleWorkflow',
      input: taskShape,
      output: summaryShape,
      start: (input) => step({
        id: 'summarize',
      })
        .do(({ task }) => done({ task, summary: 'completed: ' + task }))(input),
    });`,
    "utf8",
  );
}

describe("continuation workflow CLI e2e", () => {
  it("runs a direct workflow through the TrailStep CLI surface and persists under .trailstep/runs", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-e2e-continuation-tests", `${task.id}-direct`);
    await rm(cwd, { recursive: true, force: true });
    await writeDirectWorkflowFile(cwd);

    const cliPackage = await readCliPackageJson();
    expect(cliPackage.bin).toEqual({ trailstep: "./dist/index.js" });

    const runLines: string[] = [];
    await expect(
      main({
        argv: ["./workflows/review.mjs", "direct-run", "--input", '{"ok":true}'],
        cwd,
        env: {},
        io: { writeLine: (line) => runLines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const events = await readFile(
      join(cwd, ".trailstep", "runs", "direct-run", "events.jsonl"),
      "utf8",
    );
    expect(runLines.join("\n")).toContain("Workflow completed");
    expect(runLines.join("\n")).toContain(join(cwd, ".trailstep", "runs", "direct-run"));
    expect(events).toContain("workflow.completed");
    expect(events).toContain('"prepared":true');
  });

  it("lists and runs a local continuation workflow package through the CLI", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-e2e-continuation-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeContinuationWorkflowPackage(cwd);

    const listLines: string[] = [];
    await expect(
      main({
        argv: ["workflows"],
        cwd,
        env: {},
        io: { writeLine: (line) => listLines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(listLines).toContain("@acme/trailstep-continuation-workflows:simpleWorkflow");

    const runLines: string[] = [];
    await expect(
      main({
        argv: [
          "@acme/trailstep-continuation-workflows:simpleWorkflow",
          "run-001",
          "--input",
          '{"task":"say hello"}',
        ],
        cwd,
        env: {},
        io: { writeLine: (line) => runLines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const events = await readFile(
      join(cwd, ".trailstep", "runs", "run-001", "events.jsonl"),
      "utf8",
    );
    expect(runLines.join("\n")).toContain("Workflow completed");
    expect(events).toContain("workflow.completed");
    expect(events).toContain('"summary":"completed: say hello"');
  });
});
