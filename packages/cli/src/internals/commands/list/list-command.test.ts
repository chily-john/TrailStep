import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listCommand } from "./list-command.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("listCommand", () => {
  it("discovers workflows for the current cwd and prints their ids", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-list-command-tests", task.id);
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

    const exitCode = await listCommand.run(listCommand.parseArgs([]), {
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["@acme/stepkit-workflows:reviewFeature"]);
    expect(errors).toEqual([]);
  });

  it("prints nothing when no workflow packages are discovered", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-stepkit-list-command-tests", `${task.id}-empty`);
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];

    const exitCode = await listCommand.run(listCommand.parseArgs([]), {
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([]);
  });
});
