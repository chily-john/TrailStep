import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "./index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeContinuationWorkflowPackage(cwd: string): Promise<void> {
  const packageDir = join(cwd, "node_modules", "@acme", "stepkit-continuation-workflows");
  const coreImportUrl = pathToFileURL(resolve("..", "core", "dist", "index.js")).href;
  await mkdir(packageDir, { recursive: true });
  await writeJson(join(cwd, "package.json"), {
    name: "consumer",
    dependencies: { "@acme/stepkit-continuation-workflows": "1.0.0" },
  });
  await writeJson(join(packageDir, "package.json"), {
    name: "@acme/stepkit-continuation-workflows",
    version: "1.0.0",
    type: "module",
    main: "./index.mjs",
    keywords: ["stepkit-workflow"],
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
      start: (input) => step(
        {
          id: 'summarize',
          input,
          outputShape: summaryShape,
          run: ({ task }) => ({ task, summary: 'completed: ' + task }),
        },
        (output) => done(output),
      ),
    });`,
    "utf8",
  );
}

describe("continuation workflow CLI e2e", () => {
  it("lists and runs a local continuation workflow package through the CLI", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-e2e-continuation-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeContinuationWorkflowPackage(cwd);

    const listLines: string[] = [];
    await expect(
      main({
        argv: ["list"],
        cwd,
        io: { writeLine: (line) => listLines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(listLines).toContain("@acme/stepkit-continuation-workflows:simpleWorkflow");

    const runLines: string[] = [];
    await expect(
      main({
        argv: [
          "@acme/stepkit-continuation-workflows:simpleWorkflow",
          "run-001",
          "--input",
          '{"task":"say hello"}',
        ],
        cwd,
        io: { writeLine: (line) => runLines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    const events = await readFile(join(cwd, ".stepkit", "runs", "run-001", "events.jsonl"), "utf8");
    expect(runLines.join("\n")).toContain("Workflow completed");
    expect(events).toContain("workflow.completed");
    expect(events).toContain('"summary":"completed: say hello"');
  });
});
