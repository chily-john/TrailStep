import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../command-registry.js";

const workflowSource = [
  "const schema = { validate: () => true, diagnostics: () => [], assert: (value) => value };",
  "export default { id: 'review', inputShape: schema, start: (input) => ({ kind: 'done', output: input }) };",
].join("\n");

const describedNoInputWorkflowSource = [
  "export default {",
  "  id: 'review',",
  "  description: 'Review the active change set.',",
  "  start: () => ({ kind: 'done', output: {} })",
  "};",
].join("\n");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("addCommand", () => {
  it("accepts project and user skill flags when parsing add arguments", () => {
    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "acme",
      "--name",
      "review",
      "--project-skill",
      "--user-skill",
    ]);

    expect(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--name",
        "review",
        "--project-skill",
        "--user-skill",
      ]),
    ).toMatchObject({
      source: "./workflows/review.mjs",
      scope: "project",
      namespace: "acme",
      name: "review",
      projectSkill: true,
      userSkill: true,
    });
  });

  it("prompts for direct workflow registration details", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand(["add", "./workflows/review.mjs"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "./workflows/review.mjs"]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Config scope") {
              expect(choices).toEqual(["project", "user"]);
              return "project";
            }
            if (prompt === "Add to project skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
            if (prompt === "Add to user skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
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
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
  });

  it("skips optional skill prompts in non-interactive add without skill flags", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
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
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
    await expect(stat(resolve(cwd, ".stepkit", "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses direct workflow metadata when generating a project workflow skill", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), describedNoInputWorkflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "project",
      "--name",
      "review",
      "--project-skill",
    ]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "project",
        "--name",
        "review",
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    const skillSource = await readFile(
      join(cwd, ".stepkit", "skills", "project-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain("description: Review the active change set.");
    expect(skillSource).toContain("stepkit project/review");
    expect(skillSource).not.toContain("--input-file");
    expect(skillSource).not.toContain("sessionFile");
  });

  it("generates a project workflow skill source after registering a direct workflow with --project-skill", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "project",
      "--name",
      "review",
      "--project-skill",
    ]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "project",
        "--name",
        "review",
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    const skillSource = await readFile(
      join(cwd, ".stepkit", "skills", "project-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain("name: project-review");
    expect(skillSource).toContain("description:");
    expect(skillSource).toContain("stepkit project/review");
  });

  it("warns and returns success when skills CLI cannot be resolved", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "project",
      "--name",
      "review",
      "--project-skill",
    ]);
    const errors: string[] = [];
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "project",
        "--name",
        "review",
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        skillsCliResolver: async () => {
          throw new Error("Cannot find module 'skills/package.json'");
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    expect(errors).toContain(
      "Warning: registered project/review but could not distribute project workflow skill project-review: Could not resolve skills CLI.",
    );
  });

  it("warns and returns success when skills CLI exits non-zero", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "project",
      "--name",
      "review",
      "--project-skill",
    ]);
    const errors: string[] = [];
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "project",
        "--name",
        "review",
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
        skillsCliProcessRunner: async () => ({ exitCode: 3 }),
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    expect(errors).toContain(
      "Warning: registered project/review but could not distribute project workflow skill project-review: skills CLI exited with code 3.",
    );
  });

  it("warns for project skill pointing at user-scoped registration", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "user",
      "--namespace",
      "project",
      "--name",
      "review",
      "--project-skill",
    ]);
    const errors: string[] = [];
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "user",
        "--namespace",
        "project",
        "--name",
        "review",
        "--project-skill",
      ]) as never,
      {
        cwd,
        homeDir: cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
        skillsCliProcessRunner: async () => ({ exitCode: 0 }),
      },
    );

    expect(exitCode).toBe(0);
    expect(errors.some((line) => line.includes("teammates may not resolve"))).toBe(true);
  });

  it("warns for global skill pointing at project-scoped registration", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "project",
      "--name",
      "review",
      "--user-skill",
    ]);
    const errors: string[] = [];
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "project",
        "--name",
        "review",
        "--user-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
        skillsCliProcessRunner: async () => ({ exitCode: 0 }),
      },
    );

    expect(exitCode).toBe(0);
    expect(errors.some((line) => line.includes("only works from this project"))).toBe(true);
  });

  it("attempts project and user skill distribution independently", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const calls: string[][] = [];
    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "project",
      "--name",
      "review",
      "--project-skill",
      "--user-skill",
    ]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "project",
        "--name",
        "review",
        "--project-skill",
        "--user-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
        skillsCliProcessRunner: async (_command, args) => {
          calls.push([...args]);
          return { exitCode: calls.length === 1 ? 1 : 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      [
        "/repo/node_modules/skills/dist/index.js",
        "add",
        join(cwd, ".stepkit", "skills", "project-review"),
        "--agent",
        "*",
        "-y",
      ],
      [
        "/repo/node_modules/skills/dist/index.js",
        "add",
        join(cwd, ".stepkit", "skills", "project-review"),
        "--agent",
        "*",
        "-y",
        "-g",
      ],
    ]);
  });

  it("keeps direct workflow registration successful when project skill writing fails", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".stepkit", "skills", "project-review", "SKILL.md"), {
      recursive: true,
    });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--namespace",
      "project",
      "--name",
      "review",
      "--project-skill",
    ]);
    const errors: string[] = [];
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--namespace",
        "project",
        "--name",
        "review",
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    expect(errors).toEqual([
      "Warning: registered project/review but could not write project workflow skill project-review.",
    ]);
  });

  it("prompts for project and user skill choices in interactive add when no skill flags are provided", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const prompts: string[] = [];
    const command = resolveCommand(["add", "./workflows/review.mjs"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "./workflows/review.mjs"]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            prompts.push(prompt);
            if (prompt === "Config scope") {
              expect(choices).toEqual(["project", "user"]);
              return "project";
            }
            if (prompt === "Add to project skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "yes";
            }
            if (prompt === "Add to user skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
            throw new Error(`Unexpected prompt: ${prompt}`);
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
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual(["Config scope", "Add to project skills?", "Add to user skills?"]);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
  });

  it("prompts for skill choices in interactive add when registration details are provided", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const prompts: string[] = [];
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
        prompts: {
          select: async (prompt, choices) => {
            prompts.push(prompt);
            if (prompt === "Add to project skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "yes";
            }
            if (prompt === "Add to user skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
            throw new Error(`Unexpected prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual(["Add to project skills?", "Add to user skills?"]);
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

  it("preserves existing workflow config objects while adding string registrations", async ({
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

  it("keeps bundle registration successful when post-registration skill metadata loading fails", async ({
    task,
  }) => {
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
      stepkit: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      [
        "import { existsSync } from 'node:fs';",
        "if (existsSync(new URL('../.stepkit/config.json', import.meta.url))) {",
        "  throw new Error('metadata unavailable after registration');",
        "}",
        "export const reviewWorkflow = {",
        "  id: 'review',",
        "  description: 'Review metadata available before registration only.',",
        "  start: () => ({ kind: 'done', output: {} })",
        "};",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./local-workflow-package"]);
    const errors: string[] = [];
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
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: { acme: { review: "./local-workflow-package#review" } },
    });
    expect(errors).toEqual([
      "Warning: registered acme/review but could not write project workflow skill acme-review.",
    ]);
  });

  it("generates workflow skill content from selected local bundle workflow metadata", async ({
    task,
  }) => {
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
        "export const reviewWorkflow = {",
        "  id: 'review',",
        "  description: 'Review a local bundle change set.',",
        "  inputShape: { changeId: 'string', risk: 'number' },",
        "  start: (input) => ({ kind: 'done', output: input })",
        "};",
        "export const cleanupWorkflow = { id: 'cleanup', start: () => ({ kind: 'done', output: {} }) };",
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
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    const skillSource = await readFile(
      join(cwd, ".stepkit", "skills", "acme-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain("description: Review a local bundle change set.");
    expect(skillSource).toContain('"changeId"');
    expect(skillSource).toContain('"risk"');
    expect(skillSource).toContain(
      "stepkit acme/review --input-file .stepkit/inputs/acme-review-input.json",
    );
    expect(skillSource).toContain("Registered workflow source: `./local-workflow-package#review`");
    expect(skillSource).not.toContain('Run the StepKit workflow "acme/review".');
  });

  it("generates workflow skill content from selected installed bundle workflow metadata", async ({
    task,
  }) => {
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
    await writeFile(
      join(packageDir, "index.mjs"),
      [
        "export const reviewWorkflow = {",
        "  id: 'review',",
        "  description: 'Review an installed bundle package.',",
        "  inputShape: { ticket: 'string' },",
        "  start: (input) => ({ kind: 'done', output: input })",
        "};",
      ].join("\n"),
      "utf8",
    );

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
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    const skillSource = await readFile(
      join(cwd, ".stepkit", "skills", "acme-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain("description: Review an installed bundle package.");
    expect(skillSource).toContain('"ticket"');
    expect(skillSource).toContain(
      "stepkit acme/review --input-file .stepkit/inputs/acme-review-input.json",
    );
    expect(skillSource).toContain("Registered workflow source: `@acme/workflows#review`");
    expect(skillSource).not.toContain('Run the StepKit workflow "acme/review".');
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
    await writeFile(
      join(packageDir, "index.mjs"),
      [
        "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
        "export const cleanupWorkflow = { id: 'cleanup', start: () => ({ kind: 'done', output: {} }) };",
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
        "cleanup",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Add to project skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
            if (prompt === "Add to user skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
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
    await writeFile(
      join(packageDir, "index.mjs"),
      "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );

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
