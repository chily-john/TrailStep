import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../index.js";

async function writeSummaryWorkflow(cwd: string): Promise<void> {
  const workflowDir = join(cwd, "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "summary.mjs"),
    `import { done, step } from '@trailstep/core';
    const schema = {
      validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      diagnostics: () => [],
      assert: (value) => value,
      jsonSchema: { type: 'object' },
    };
    export const complete = {
      id: 'complete',
      input: schema,
      output: schema,
      start: (input) => step({ id: 'summarize' }).do(() => done({ summary: 'completed ' + input.task }))(input),
    };
    export const waiting = {
      id: 'waiting',
      input: schema,
      output: schema,
      start: (input) => step({ id: 'approval' })
        .wait({ id: 'approval', kind: 'input', message: 'Approve?', output: { approved: 'boolean' } })
        .do(() => done({ summary: 'approved' }))(input),
    };`,
    "utf8",
  );
}

describe("output command", () => {
  it("prints a selected final output field", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeSummaryWorkflow(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["./workflows/summary.mjs#complete", "complete-run", "--input", '{"task":"tests"}'],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(
      main({
        argv: ["output", "complete-run", "--field", "summary"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual(["completed tests"]);
  });

  it("reports no final output for a waiting run", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-output-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeSummaryWorkflow(cwd);
    const errors: string[] = [];

    await expect(
      main({
        argv: ["./workflows/summary.mjs#waiting", "waiting-run", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    await expect(
      main({
        argv: ["output", "waiting-run"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toContain("No final workflow output found for waiting-run");
    expect(errors.join("\n")).toContain("run status is waiting");
  });
});
