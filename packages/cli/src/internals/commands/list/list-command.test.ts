import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../command-registry.js";
import { listCommand } from "./list-command.js";

function tmpDir(task: { readonly id: string }): string {
  return join("node_modules", ".tmp-stepkit-list-command-tests", `${task.id}-${randomUUID()}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
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

  it("groups registered entries by scope, ordered project-local, project, user", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const homeDir = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, ".stepkit", "config-local.json"), {
      workflows: { project: { scratch: "./scratch.mjs" } },
    });
    await writeJson(join(homeDir, ".stepkit", "config.json"), {
      workflows: { deploy: { prod: "./deploy.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    const exitCode = await listCommand.run(listCommand.parseArgs(["list"]), {
      cwd,
      homeDir,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      "Project (local):",
      "  project/scratch -> ./scratch.mjs",
      "Project (shared):",
      "  project/review -> ./review.mjs",
      "User:",
      "  deploy/prod -> ./deploy.mjs",
    ]);
  });

  it("routes stepkit list --edit through command-registry", () => {
    const command = resolveCommand(["list", "--edit"]);
    expect(command.parseArgs(["list", "--edit"])).toEqual({ edit: true });
  });

  it("prints a message and exits 0 when there is nothing to edit", async ({ task }) => {
    const cwd = tmpDir(task);
    const lines: string[] = [];
    const exitCode = await listCommand.run(listCommand.parseArgs(["list", "--edit"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["No registered workflows to edit."]);
  });

  it("requires an interactive session for --edit", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });

    await expect(
      listCommand.run(listCommand.parseArgs(["list", "--edit"]), {
        cwd,
        homeDir: tmpDir(task),
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).rejects.toThrow(/requires an interactive session/);
  });

  it("renames a registered workflow's namespace and name via --edit", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });

    const lines: string[] = [];
    const exitCode = await listCommand.run(listCommand.parseArgs(["list", "--edit"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          expect(prompt).toBe("Select a workflow to edit");
          expect(choices).toEqual(["project: project/review -> ./review.mjs"]);
          return choices[0] as string;
        },
        text: async (prompt) => {
          if (prompt === "New namespace") {
            return "acme";
          }
          if (prompt === "New name") {
            return "reviewed";
          }
          throw new Error(`Unexpected prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["Renamed project: project/review -> acme/reviewed"]);
    const config = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        join(cwd, ".stepkit", "config.json"),
        "utf8",
      ),
    ) as unknown;
    expect(config).toEqual({ workflows: { acme: { reviewed: "./review.mjs" } } });
  });

  it("asks to overwrite and aborts cleanly on 'no' when the destination already exists", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: {
        project: { review: "./review.mjs" },
        acme: { cleanup: "./cleanup.mjs" },
      },
    });

    const lines: string[] = [];
    const exitCode = await listCommand.run(listCommand.parseArgs(["list", "--edit"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            const index = choices.indexOf("project: project/review -> ./review.mjs");
            expect(index).toBeGreaterThanOrEqual(0);
            return choices[index] as string;
          }
          expect(prompt).toContain("acme/cleanup already exists");
          return "no";
        },
        text: async (prompt) => {
          if (prompt === "New namespace") {
            return "acme";
          }
          if (prompt === "New name") {
            return "cleanup";
          }
          throw new Error(`Unexpected prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["Cancelled."]);
    const config = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        join(cwd, ".stepkit", "config.json"),
        "utf8",
      ),
    ) as unknown;
    expect(config).toEqual({
      workflows: {
        project: { review: "./review.mjs" },
        acme: { cleanup: "./cleanup.mjs" },
      },
    });
  });
});
