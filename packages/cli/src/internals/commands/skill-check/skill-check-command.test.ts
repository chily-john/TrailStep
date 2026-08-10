import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createConsumer(cwd: string): Promise<string> {
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
    "export const reviewFeature = { id: 'reviewFeature', inputShape: { task: 'string' }, start: (input) => ({ kind: 'done', output: input }) };",
    "utf8",
  );
  return packageDir;
}

describe("skill-check command", () => {
  it("prints packages missing SKILL.md with workflow ids and exits zero", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-skill-check-tests", task.id);
    await mkdir(cwd, { recursive: true });
    await createConsumer(cwd);
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["skill-check"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      "Missing SKILL.md for @acme/trailstep-workflows: @acme/trailstep-workflows:reviewFeature",
    ]);
    expect(errors).toEqual([]);
  });

  it("prints nothing when every workflow package has SKILL.md", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-skill-check-tests", `${task.id}-present`);
    await mkdir(cwd, { recursive: true });
    const packageDir = await createConsumer(cwd);
    await writeFile(join(packageDir, "SKILL.md"), "# Workflow skill\n", "utf8");
    const lines: string[] = [];

    const exitCode = await main({
      argv: ["skill-check"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([]);
  });
});
