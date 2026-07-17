import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../command-registry.js";

const workflowSource = [
  "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
  "export default { id: 'review', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
].join("\n");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("addCommand", () => {
  it("prompts for direct workflow registration details", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand(["add", "./workflows/review.mjs"]);
    const exitCode = await command.run(command.parseArgs(["add", "./workflows/review.mjs"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          expect(prompt).toBe("Config scope");
          expect(choices).toEqual(["project", "user"]);
          return "project";
        },
        text: async (prompt) => {
          if (prompt === "Namespace") {
            return "acme";
          }
          if (prompt === "Workflow name") {
            return "review";
          }
          throw new Error(`Unexpected prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
  });

  it("adds a direct workflow file to project config and preserves working agents", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      version: 1,
      workingAgents: { reviewer: { command: "reviewer" } },
    });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "acme",
      "--name",
      "review",
    ]);
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--name",
        "review",
      ]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(join(cwd, ".stepkit", "config.json"))).toEqual({
      version: 1,
      workingAgents: { reviewer: { command: "reviewer" } },
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
    expect(lines).toEqual(["Registered acme/review -> ./workflows/review.mjs in project config."]);
    expect(errors).toEqual([]);
  });

  it("preserves existing workflow config objects while adding string registrations", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".stepkit"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      version: 1,
      workflows: {
        release: { workingAgent: "builder", interactiveAgent: "reviewer", limits: { retries: 1 } },
        acme: { existing: "./workflows/existing.mjs" },
      },
    });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand(["add", "./workflows/review.mjs"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--name",
        "review",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(join(cwd, ".stepkit", "config.json"))).toEqual({
      version: 1,
      workflows: {
        release: { workingAgent: "builder", interactiveAgent: "reviewer", limits: { retries: 1 } },
        acme: { existing: "./workflows/existing.mjs", review: "./workflows/review.mjs" },
      },
    });
  });

  it("adds only the selected workflow from a bundle manifest", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      stepkit: {
        workflows: {
          review: "./index.mjs#reviewWorkflow",
          cleanup: "./index.mjs#cleanupWorkflow",
        },
      },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      [
        "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
        "export const reviewWorkflow = { id: 'review', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
        "export const cleanupWorkflow = { id: 'cleanup', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./local-workflow-package"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./local-workflow-package",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--name",
        "review",
        "--workflow",
        "review",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { review: "./local-workflow-package#review" } },
    });
  });

  it("prompts for which workflow to register from a bundle manifest", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      stepkit: {
        workflows: {
          review: "./index.mjs#reviewWorkflow",
          cleanup: "./index.mjs#cleanupWorkflow",
        },
      },
    });

    const command = resolveCommand(["add", "./local-workflow-package"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./local-workflow-package",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--name",
        "cleanup",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["review", "cleanup"]);
            return "cleanup";
          },
          text: async () => {
            throw new Error("Unexpected text prompt");
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { cleanup: "./local-workflow-package#cleanup" } },
    });
  });

  it("adds a selected installed package bundle workflow by package ref", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      type: "module",
      exports: { "./package.json": "./package.json" },
      stepkit: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });

    const command = resolveCommand(["add", "@acme/workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "@acme/workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--name",
        "review",
        "--workflow",
        "review",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { review: "@acme/workflows#review" } },
    });
  });

  it("fails clearly when an installed bundle package cannot be resolved", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(cwd, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });

    const command = resolveCommand(["add", "@acme/workflows"]);
    await expect(
      command.run(
        command.parseArgs([
          "add",
          "@acme/workflows",
          "--scope",
          "project",
          "--namespace",
          "acme",
          "--name",
          "review",
          "--workflow",
          "review",
        ]) as never,
        {
          cwd,
          io: { writeLine: () => undefined, writeError: () => undefined },
        },
      ),
    ).rejects.toThrow(/Bundle package not found: @acme\/workflows/);
  });
});
