import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../../index.js";

async function writeTemplateWorkflow(cwd: string): Promise<void> {
  const workflowDir = join(cwd, "workflows");
  await mkdir(workflowDir, { recursive: true });
  await writeFile(
    join(workflowDir, "delegate.mjs"),
    `import { done, jsonSchema } from '@trailstep/core';
    export default {
      id: 'delegate',
      input: jsonSchema({
        type: 'object',
        properties: {
          task: { type: 'string' },
          context: { type: 'string' },
          mode: { type: 'string', default: 'general' },
          summarize: { type: 'boolean', default: true },
        },
        required: ['task', 'context', 'mode', 'summarize'],
        additionalProperties: false,
      }),
      start: () => done({ ok: true }),
    };`,
    "utf8",
  );
}

describe("input-template command", () => {
  it("generates expected JSON for a simple input schema", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-input-template-tests", task.id);
    await rm(cwd, { recursive: true, force: true });
    await writeTemplateWorkflow(cwd);
    const lines: string[] = [];

    await expect(
      main({
        argv: ["input-template", "./workflows/delegate.mjs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(lines.join("\n"))).toEqual({
      task: "",
      context: "",
      mode: "general",
      summarize: true,
    });
  });
});
