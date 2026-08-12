import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../command-registry.js";

function tmpDir(task: { readonly id: string }): string {
  return join("node_modules", ".tmp-trailstep-remove-command-tests", `${task.id}-${randomUUID()}`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("removeCommand", () => {
  it("removes a registration found in exactly one scope", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });

    const command = resolveCommand(["remove", "project/review"]);
    const lines: string[] = [];
    const exitCode = await command.run(command.parseArgs(["remove", "project/review"]) as never, {
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["Removed project/review from project config."]);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({ workflows: {} });
  });

  it("removes package metadata with the registration", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        project: {
          review: {
            kind: "package",
            sourceType: "npm",
            packageName: "@acme/workflows",
            requestedSpec: "@acme/workflows@latest",
            requestedRange: "latest",
            installScope: "project",
            targetRef: "@acme/workflows#review",
            workflowName: "review",
            exportName: "review",
          },
        },
      },
    });

    const command = resolveCommand(["remove", "project/review"]);
    await command.run(command.parseArgs(["remove", "project/review"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
    });

    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({ workflows: {} });
  });

  it("removes the entry but keeps sibling entries in the same namespace bucket", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs", cleanup: "./cleanup.mjs" } },
    });

    const command = resolveCommand(["remove", "project/review"]);
    await command.run(command.parseArgs(["remove", "project/review"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
    });

    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { cleanup: "./cleanup.mjs" } },
    });
  });

  it("errors when the ref is not found in any scope", async ({ task }) => {
    const cwd = tmpDir(task);
    const command = resolveCommand(["remove", "project/missing"]);
    await expect(
      command.run(command.parseArgs(["remove", "project/missing"]) as never, {
        cwd,
        homeDir: tmpDir(task),
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).rejects.toThrow(/not found: project\/missing/);
  });

  it("errors and asks for --scope when the ref matches more than one scope", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./shared-review.mjs" } },
    });
    await writeJson(join(cwd, ".trailstep", "config-local.json"), {
      workflows: { project: { review: "./local-review.mjs" } },
    });

    const command = resolveCommand(["remove", "project/review"]);
    await expect(
      command.run(command.parseArgs(["remove", "project/review"]) as never, {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).rejects.toThrow(/more than one scope.*local, project/s);
  });

  it("removes only the file forced by --scope when the ref exists in more than one", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./shared-review.mjs" } },
    });
    await writeJson(join(cwd, ".trailstep", "config-local.json"), {
      workflows: { project: { review: "./local-review.mjs" } },
    });

    const command = resolveCommand(["remove", "project/review", "--scope", "local"]);
    const lines: string[] = [];
    const exitCode = await command.run(
      command.parseArgs(["remove", "project/review", "--scope", "local"]) as never,
      { cwd, io: { writeLine: (line) => lines.push(line), writeError: () => undefined } },
    );

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["Removed project/review from local config."]);
    expect(await readJson(join(cwd, ".trailstep", "config-local.json"))).toEqual({ workflows: {} });
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./shared-review.mjs" } },
    });
  });

  it("throws when running against a ref that is not in <namespace>/<name> form", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const command = resolveCommand(["remove", "no-slash-here"]);
    await expect(
      command.run(command.parseArgs(["remove", "no-slash-here"]) as never, {
        cwd,
        homeDir: tmpDir(task),
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).rejects.toThrow(/Invalid workflow ref/);
  });

  it("prints a non-blocking notice when a matching skill directory still exists", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await mkdir(join(cwd, ".trailstep", "skills", "trst-review"), { recursive: true });

    const command = resolveCommand(["remove", "project/review"]);
    const errors: string[] = [];
    await command.run(command.parseArgs(["remove", "project/review"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(
      errors.some((line) => line.includes("skill directory") && line.includes("not removed")),
    ).toBe(true);
    await expect(stat(join(cwd, ".trailstep", "skills", "trst-review"))).resolves.toBeTruthy();
  });
});
