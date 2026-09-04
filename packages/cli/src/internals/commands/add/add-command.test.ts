import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../../index.js";
import { TEST_CUSTOM_PROVIDERS } from "../../../test/provider-fixtures.js";
import { resolveCommand } from "../../command-registry.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";

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

const reviewerAgentWorkflowSource = [
  "export default {",
  "  id: 'review',",
  "  agents: { reviewer: { size: 'medium', description: 'Review code' } },",
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

  it("plans a fresh package add dry-run without installing or writing files", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["add", "@acme/workflows@latest", "--scope", "project", "--dry-run"],
      cwd,
      homeDir,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: async () => {
        throw new Error("package command runner should not be called during dry-run");
      },
    });

    expect(exitCode).toBe(0);
    const output = [...lines, ...errors].join("\n");
    expect(output).toContain("Dry run");
    expect(output).toContain("@acme/workflows@latest");
    expect(output).toContain("project");
    expect(output).toContain(cwd);
    await expect(stat(resolve(cwd, ".trailstep", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(resolve(cwd, ".trailstep", "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(resolve(cwd, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(cwd, "package-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(resolve(cwd, "pnpm-lock.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(resolve(cwd, "node_modules", "@acme", "workflows"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(resolve(homeDir, ".trailstep", "packages"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports blocking conflicts in package dry-run yes mode without mutation", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(configPath, {
      workflows: { project: { review: "./existing.mjs" } },
    });
    const beforeConfig = await readFile(configPath, "utf8");
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.2.3",
      type: "module",
      exports: { "./package.json": "./package.json" },
      trailstep: {
        workflows: {
          review: "./index.mjs#reviewWorkflow",
          release: "./index.mjs#releaseWorkflow",
        },
      },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      [
        "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
        "export const releaseWorkflow = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["add", "@acme/workflows@latest", "--yes", "--dry-run"],
      cwd,
      homeDir,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: async () => {
        throw new Error("package command runner should not be called during dry-run");
      },
    });

    expect(exitCode).not.toBe(0);
    expect([...lines, ...errors].join("\n")).toMatch(/conflict|already exists/i);
    await expect(readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    await expect(readJson(join(packageDir, "package.json"))).resolves.toMatchObject({
      name: "@acme/workflows",
      version: "1.2.3",
    });
  });

  it("rejects direct workflow dry-run without writing config", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await main({
      argv: ["add", "./workflows/review.mjs", "--scope", "project", "--dry-run"],
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
    });

    expect(exitCode).not.toBe(0);
    expect([...lines, ...errors].join("\n")).toMatch(/package-backed only/i);
    await expect(stat(resolve(cwd, ".trailstep", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("prompts for scope only in a zero-flag add, deriving namespace and name", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const selectPrompts: string[] = [];
    const command = resolveCommand(["add", "./workflows/review.mjs"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "./workflows/review.mjs"]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            selectPrompts.push(prompt);
            if (prompt.startsWith("Where should this workflow be registered?")) {
              expect(choices).toEqual(["local", "project", "global"]);
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
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(selectPrompts).toEqual([
      "Where should this workflow be registered? (local = just you on this repo, project = shared with your team, global = global across all your projects)",
      "Add to project skills?",
      "Add to user skills?",
    ]);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
  });

  it("derives the name from workflow.id and skips namespace/name prompts for project scope", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand(["add", "./workflows/review.mjs", "--scope", "local"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "./workflows/review.mjs", "--scope", "local"]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config-local.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
  });

  it("supports an explicit --name override without deriving from workflow.id", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "project",
      "--name",
      "custom-name",
    ]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "project",
        "--name",
        "custom-name",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { "custom-name": "./workflows/review.mjs" } },
    });
  });

  it("rejects a workflow id containing a reserved character when no --name is given", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "export default { id: 'team/review', start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows/review.mjs", "--scope", "project"]);
    await expect(
      command.run(
        command.parseArgs(["add", "./workflows/review.mjs", "--scope", "project"]) as never,
        {
          cwd,
          io: { writeLine: () => undefined, writeError: () => undefined },
        },
      ),
    ).rejects.toThrow(/reserved character/);
  });

  it("rejects --namespace project combined with --scope global", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "global",
      "--namespace",
      "project",
      "--name",
      "review",
    ]);
    await expect(
      command.run(
        command.parseArgs([
          "add",
          "./workflows/review.mjs",
          "--scope",
          "global",
          "--namespace",
          "project",
          "--name",
          "review",
        ]) as never,
        {
          cwd,
          homeDir: cwd,
          io: { writeLine: () => undefined, writeError: () => undefined },
        },
      ),
    ).rejects.toThrow(/Namespace "project" is reserved/);
  });

  it("warns for a duplicate registration across project and local scope", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./workflows/existing.mjs" } },
    });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "local",
      "--name",
      "review",
    ]);
    const errors: string[] = [];
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "local",
        "--name",
        "review",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toContain(
      "Warning: skipped project/review because it already exists in project config. Use --force to replace it.",
    );
  });

  it("skips optional skill prompts in non-interactive add without skill flags", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
    await expect(stat(resolve(cwd, ".trailstep", "skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses direct workflow metadata when generating a project workflow skill", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
      join(cwd, ".trailstep", "skills", "trst-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain('description: "[project] Review the active change set."');
    expect(skillSource).toContain("trailstep project/review");
    expect(skillSource).not.toContain("--input-file");
    expect(skillSource).not.toContain("sessionFile");
  });

  it("generates a project workflow skill source after registering a direct workflow with --project-skill", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    const skillSource = await readFile(
      join(cwd, ".trailstep", "skills", "trst-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain("name: trst-review");
    expect(skillSource).toContain("description:");
    expect(skillSource).toContain("trailstep project/review");
  });

  it("warns and returns success when skills CLI cannot be resolved", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    expect(errors).toContain(
      "Warning: registered project/review but could not distribute project workflow skill trst-review: Could not resolve skills CLI.",
    );
  });

  it("warns and returns success when skills CLI exits non-zero", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    expect(errors).toContain(
      "Warning: registered project/review but could not distribute project workflow skill trst-review: skills CLI exited with code 3.",
    );
  });

  it("warns for global skill pointing at project-scoped registration", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
      ".tmp-trailstep-add-command-tests",
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
        join(cwd, ".trailstep", "skills", "trst-review"),
        "--agent",
        "*",
        "-y",
      ],
      [
        "/repo/node_modules/skills/dist/index.js",
        "add",
        join(cwd, ".trailstep", "skills", "trst-review"),
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
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".trailstep", "skills", "trst-review", "SKILL.md"), {
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    expect(errors).toEqual([
      "Warning: registered project/review but could not write project workflow skill trst-review.",
    ]);
  });

  it("prompts for project and user skill choices in interactive add when no skill flags are provided", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
            if (prompt.startsWith("Where should this workflow be registered?")) {
              expect(choices).toEqual(["local", "project", "global"]);
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
            throw new Error(`Unexpected prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "Where should this workflow be registered? (local = just you on this repo, project = shared with your team, global = global across all your projects)",
      "Add to project skills?",
      "Add to user skills?",
    ]);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
  });

  it("prompts for skill choices in interactive add when registration details are provided", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
  });

  it("prompts for uncovered workflow roles after direct workflow registration", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
    });
    await writeFile(join(cwd, "workflows", "review.mjs"), reviewerAgentWorkflowSource, "utf8");

    const homeDir = join(cwd, "home");
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
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            prompts.push(prompt);
            if (prompt === "Configure workflow role reviewer (medium) — Review code") {
              expect(choices).toEqual(["Use named agent", "Create new agent", "Skip"]);
              return "Use named agent";
            }
            if (prompt === "Named agent for workflow role reviewer") {
              expect(choices).toContain("reviewerAgent");
              return "reviewerAgent";
            }
            if (prompt === "Add to project skills?") {
              return "no";
            }
            if (prompt === "Add to user skills?") {
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "Add to project skills?",
      "Add to user skills?",
      "Configure workflow role reviewer (medium) — Review code",
      "Named agent for workflow role reviewer",
    ]);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
      workflows: {
        acme: { review: "./workflows/review.mjs" },
        review: { agents: { reviewer: [{ ref: "reviewerAgent" }] } },
      },
    });
  });

  it("prompts once for shared uncovered bulk role names and fans out the mapping", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
    });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', agents: { reviewer: { size: 'medium', description: 'Review code' } }, start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', agents: { reviewer: { size: 'medium', description: 'Review code' } }, start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const homeDir = join(cwd, "home");
    const prompts: string[] = [];
    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "*",
      ]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            prompts.push(prompt);
            if (prompt === "Configure workflow role reviewer (medium) — Review code") {
              expect(choices).toEqual(["Use named agent", "Create new agent", "Skip"]);
              return "Use named agent";
            }
            if (prompt === "Named agent for workflow role reviewer") {
              expect(choices).toContain("reviewerAgent");
              return "reviewerAgent";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "Configure workflow role reviewer (medium) — Review code",
      "Named agent for workflow role reviewer",
    ]);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
      workflows: {
        acme: { alpha: "./workflows#alpha", beta: "./workflows#beta" },
        alpha: { agents: { reviewer: [{ ref: "reviewerAgent" }] } },
        beta: { agents: { reviewer: [{ ref: "reviewerAgent" }] } },
      },
    });
  });

  it("does not prompt for skipped-conflict workflow roles", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
      workflows: { acme: { alpha: "./workflows/existing.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', agents: { reviewer: { size: 'medium', description: 'Review code' } }, start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', agents: { reviewer: { size: 'medium', description: 'Review code' } }, start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const homeDir = join(cwd, "home");
    const prompts: string[] = [];
    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "*",
      ]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            if (
              prompt === "acme/alpha already exists in project config. What should TrailStep do?"
            ) {
              expect(choices).toEqual([
                "Replace existing registration",
                "Skip this workflow",
                "Cancel add",
              ]);
              return "Skip this workflow";
            }
            prompts.push(prompt);
            if (prompt === "Configure workflow role reviewer (medium) — Review code") {
              expect(choices).toEqual(["Use named agent", "Create new agent", "Skip"]);
              return "Use named agent";
            }
            if (prompt === "Named agent for workflow role reviewer") {
              return "reviewerAgent";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "Configure workflow role reviewer (medium) — Review code",
      "Named agent for workflow role reviewer",
    ]);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
      workflows: {
        acme: { alpha: "./workflows/existing.mjs", beta: "./workflows#beta" },
        beta: { agents: { reviewer: [{ ref: "reviewerAgent" }] } },
      },
    });
  });

  it("dedupes role prompts by role name regardless of size", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
    });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', agents: { reviewer: { size: 'small', description: 'Review code' } }, start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', agents: { reviewer: { size: 'large', description: 'Review code' } }, start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const homeDir = join(cwd, "home");
    const prompts: string[] = [];
    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "*",
      ]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            prompts.push(prompt);
            if (prompt === "Configure workflow role reviewer (small) — Review code") {
              expect(choices).toEqual(["Use named agent", "Create new agent", "Skip"]);
              return "Use named agent";
            }
            if (prompt === "Named agent for workflow role reviewer") {
              return "reviewerAgent";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(prompts).toEqual([
      "Configure workflow role reviewer (small) — Review code",
      "Named agent for workflow role reviewer",
    ]);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: {
        reviewerAgent: [{ provider: "claude", model: "sonnet" }],
      },
      workflows: {
        acme: { alpha: "./workflows#alpha", beta: "./workflows#beta" },
        alpha: { agents: { reviewer: [{ ref: "reviewerAgent" }] } },
        beta: { agents: { reviewer: [{ ref: "reviewerAgent" }] } },
      },
    });
  });

  it("does not prompt for workflow roles covered by default fallback", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: { default: [{ provider: "claude", model: "sonnet" }] },
    });
    await writeFile(join(cwd, "workflows", "review.mjs"), reviewerAgentWorkflowSource, "utf8");

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
          select: async (prompt) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      customProviders: TEST_CUSTOM_PROVIDERS,
      agents: { default: [{ provider: "claude", model: "sonnet" }] },
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
  });

  it("adds a direct workflow file to project config and preserves agent config", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {
        reviewer: { binary: "reviewer" },
      },
      agents: {
        reviewer: [{ provider: "reviewer" }],
      },
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
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      version: 1,
      customProviders: {
        reviewer: { binary: "reviewer" },
      },
      agents: {
        reviewer: [{ provider: "reviewer" }],
      },
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
    expect(lines).toEqual(["Registered acme/review -> ./workflows/review.mjs in project config."]);
    expect(errors).toEqual([]);
  });

  it("registers a selected workflow from a direct source barrel", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "daily-note.ts"),
      [
        "const schema = { validate: () => true, diagnostics: () => [], assert: (value: unknown) => value };",
        "export const dailyNote = { id: 'dailyNote', inputShape: schema, start: (input: unknown) => ({ kind: 'done', output: input }) };",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(cwd, "workflows", "release.ts"),
      "export const release = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export { release } from './release.js';",
        "export { dailyNote } from './daily-note.js';",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand([
      "add",
      "./workflows",
      "--workflow",
      "dailyNote",
      "--scope",
      "project",
      "--namespace",
      "acme",
    ]);
    const lines: string[] = [];

    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--workflow",
        "dailyNote",
        "--scope",
        "project",
        "--namespace",
        "acme",
      ]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { dailyNote: "./workflows#dailyNote" } },
    });
    expect(lines).toEqual([
      "Registered acme/dailyNote -> ./workflows#dailyNote in project config.",
    ]);
  });

  it("lists direct barrel workflow choices in alphabetical order", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const zebra = { id: 'zebra', start: () => ({ kind: 'done', output: {} }) };",
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Workflow");
            expect(choices).toEqual(["Select all", "alpha", "zebra"]);
            return ["zebra"];
          },
          text: async () => {
            throw new Error("Unexpected text prompt");
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { zebra: "./workflows#zebra" } },
    });
  });

  it("adds a direct workflow file to local config without touching project config", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {
        reviewer: { binary: "reviewer" },
      },
      agents: {
        reviewer: [{ provider: "reviewer" }],
      },
    });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource, "utf8");

    const command = resolveCommand([
      "add",
      "./workflows/review.mjs",
      "--scope",
      "local",
      "--namespace",
      "acme",
      "--name",
      "review",
    ]);
    const lines: string[] = [];

    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows/review.mjs",
        "--scope",
        "local",
        "--namespace",
        "acme",
        "--name",
        "review",
      ]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(join(cwd, ".trailstep", "config-local.json"))).toEqual({
      workflows: { acme: { review: "./workflows/review.mjs" } },
    });
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      version: 1,
      customProviders: {
        reviewer: { binary: "reviewer" },
      },
      agents: {
        reviewer: [{ provider: "reviewer" }],
      },
    });
    expect(lines).toEqual(["Registered acme/review -> ./workflows/review.mjs in local config."]);
  });

  it("preserves existing workflow config objects while adding string registrations", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
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
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
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
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      [
        "import { existsSync } from 'node:fs';",
        "if (existsSync(new URL('../.trailstep/config.json', import.meta.url))) {",
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { review: "./local-workflow-package#review" } },
    });
    expect(errors).toEqual([
      "Warning: registered acme/review but could not write project workflow skill trst-review.",
    ]);
  });

  it("generates workflow skill content from selected local bundle workflow metadata", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: {
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
        skillsCliResolver: async () => {
          throw new Error("Could not resolve skills CLI.");
        },
      },
    );

    expect(exitCode).toBe(0);
    const skillSource = await readFile(
      join(cwd, ".trailstep", "skills", "trst-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain('description: "[acme] Review a local bundle change set."');
    expect(skillSource).toContain('"changeId"');
    expect(skillSource).toContain('"risk"');
    expect(skillSource).toContain(
      "trailstep acme/review --input-file .trailstep/inputs/trst-review-input.json",
    );
    expect(skillSource).toContain("Registered workflow source: `./local-workflow-package#review`");
    expect(skillSource).not.toContain('Run the TrailStep workflow "acme/review".');
  });

  it("generates workflow skill content from selected installed bundle workflow metadata", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      type: "module",
      exports: { "./package.json": "./package.json" },
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
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
        skillsCliResolver: async () => {
          throw new Error("Could not resolve skills CLI.");
        },
      },
    );

    expect(exitCode).toBe(0);
    const skillSource = await readFile(
      join(cwd, ".trailstep", "skills", "trst-review", "SKILL.md"),
      "utf8",
    );
    expect(skillSource).toContain('description: "[acme] Review an installed bundle package."');
    expect(skillSource).toContain('"ticket"');
    expect(skillSource).toContain(
      "trailstep acme/review --input-file .trailstep/inputs/trst-review-input.json",
    );
    expect(skillSource).toContain("Registered workflow source: `@acme/workflows#review`");
    expect(skillSource).not.toContain('Run the TrailStep workflow "acme/review".');
  });

  it("adds only the selected workflow from a bundle manifest", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: {
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { review: "./local-workflow-package#review" } },
    });
  });

  it("preserves bundle manifest order when listing add candidates", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: {
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
          select: async (prompt) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["Select all", "review", "cleanup"]);
            return ["cleanup"];
          },
          text: async () => {
            throw new Error("Unexpected text prompt");
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { cleanup: "./local-workflow-package#cleanup" } },
    });
  });

  it("prompts for which workflow to register from a bundle manifest", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: {
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
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["Select all", "review", "cleanup"]);
            return ["cleanup"];
          },
          text: async () => {
            throw new Error("Unexpected text prompt");
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { cleanup: "./local-workflow-package#cleanup" } },
    });
  });

  it("prompts with Select all and registers all selected workflows", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: {
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
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              expect(choices).toEqual(["yes", "no"]);
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["Select all", "review", "cleanup"]);
            return ["review", "cleanup"];
          },
          text: async () => {
            throw new Error("Unexpected text prompt");
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: {
        acme: {
          review: "./local-workflow-package#review",
          cleanup: "./local-workflow-package#cleanup",
        },
      },
    });
  });

  it("treats Select all as a submit-time override", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Workflow");
            expect(choices).toEqual(["Select all", "alpha", "beta"]);
            return ["Select all", "alpha"];
          },
          text: async () => {
            throw new Error("Unexpected text prompt");
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { alpha: "./workflows#alpha", beta: "./workflows#beta" } },
    });
  });

  it("registers all bundle workflows for --workflow '*'", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: {
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
    const lines: string[] = [];
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./local-workflow-package",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "*",
      ]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: {
        acme: {
          review: "./local-workflow-package#review",
          cleanup: "./local-workflow-package#cleanup",
        },
      },
    });
    expect(lines).toContain("Summary: registered 2, skipped conflicts 0, skill warnings 0.");
  });

  it("registers a comma-separated direct barrel subset in source order", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', start: () => ({ kind: 'done', output: {} }) };",
        "export const gamma = { id: 'gamma', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "gamma,alpha",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { alpha: "./workflows#alpha", gamma: "./workflows#gamma" } },
    });
  });

  it("allows --name for exactly one selected workflow", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "alpha",
        "--name",
        "custom",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { custom: "./workflows#alpha" } },
    });
  });

  it("rejects --name for multiple selected workflows", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    await expect(
      command.run(
        command.parseArgs([
          "add",
          "./workflows",
          "--scope",
          "project",
          "--namespace",
          "acme",
          "--workflow",
          "alpha,beta",
          "--name",
          "custom",
        ]) as never,
        {
          cwd,
          io: { writeLine: () => undefined, writeError: () => undefined },
        },
      ),
    ).rejects.toThrow(/--name can only be used when registering one workflow/);
  });

  it("skips only conflicting workflows without --force", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { acme: { alpha: "./workflows/existing.mjs", settings: { agents: {} } } },
    });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const errors: string[] = [];
    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "*",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: {
        acme: {
          alpha: "./workflows/existing.mjs",
          beta: "./workflows#beta",
          settings: { agents: {} },
        },
      },
    });
    expect(errors).toContain(
      "Warning: skipped acme/alpha because it already exists in project config. Use --force to replace it.",
    );
  });

  it("generates one project skill per successfully registered workflow", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', description: 'Alpha flow.', start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', description: 'Beta flow.', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "*",
        "--project-skill",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        skillsCliResolver: async () => {
          throw new Error("Could not resolve skills CLI.");
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(
      await readFile(join(cwd, ".trailstep", "skills", "trst-alpha", "SKILL.md"), "utf8"),
    ).toContain("trailstep acme/alpha");
    expect(
      await readFile(join(cwd, ".trailstep", "skills", "trst-beta", "SKILL.md"), "utf8"),
    ).toContain("trailstep acme/beta");
  });

  it("prints a bulk registration summary", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { acme: { alpha: "./workflows/existing.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
        "export const beta = { id: 'beta', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const lines: string[] = [];
    const command = resolveCommand(["add", "./workflows"]);
    const exitCode = await command.run(
      command.parseArgs([
        "add",
        "./workflows",
        "--scope",
        "project",
        "--namespace",
        "acme",
        "--workflow",
        "*",
      ]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(lines).toContain("Summary: registered 1, skipped conflicts 1, skill warnings 0.");
  });

  it("rolls back a fresh package install when package discovery fails", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const lines: string[] = [];
    const errors: string[] = [];
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const exitCode = await main({
      argv: ["add", "@acme/workflows@latest", "--scope", "project"],
      cwd,
      homeDir,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      packageCommandRunner: async (request) => {
        installRequests.push(request);
        await writeJson(join(cwd, "package.json"), {
          devDependencies: { "@acme/workflows": "latest" },
        });
        await writeFile(join(cwd, "package-lock.json"), "lockfile\n", "utf8");
        await mkdir(packageDir, { recursive: true });
        await writeJson(join(packageDir, "package.json"), {
          name: "@acme/workflows",
          version: "1.2.3",
          type: "module",
          exports: { "./package.json": "./package.json" },
        });
        return { exitCode: 0 };
      },
    });

    expect(exitCode).toBe(1);
    expect(installRequests).toEqual([
      { command: "npm", args: expect.arrayContaining(["@acme/workflows@latest"]), cwd },
    ]);
    expect(errors.join("\n")).toMatch(
      /Missing trailstep\.workflows manifest metadata in bundle package: @acme\/workflows/,
    );
    expect([...lines, ...errors].join("\n")).toMatch(
      /Cleanup: rolled back package install for @acme\/workflows in project scope\./,
    );
    await expect(stat(resolve(cwd, ".trailstep", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, "package-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a reused package when discovery fails", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.2.3",
      type: "module",
      exports: { "./package.json": "./package.json" },
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const exitCode = await main({
      argv: ["add", "@acme/workflows@latest", "--scope", "project"],
      cwd,
      homeDir,
      io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      prompts: {
        select: async (prompt, choices) => {
          if (
            prompt ===
            "Package @acme/workflows is already installed in project scope. What should TrailStep do?"
          ) {
            expect(choices).toEqual(["Reuse installed package", "Reinstall/upgrade", "Cancel"]);
            return "Reuse installed package";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async (prompt) => {
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
      },
      packageCommandRunner: async (request) => {
        installRequests.push(request);
        return { exitCode: 0 };
      },
    });

    expect(exitCode).toBe(1);
    expect(installRequests).toEqual([]);
    expect(errors.join("\n")).toMatch(
      /Missing trailstep\.workflows manifest metadata in bundle package: @acme\/workflows/,
    );
    expect([...lines, ...errors].join("\n")).toMatch(
      /Cleanup: preserved existing package @acme\/workflows in project scope; no package install rollback was run\./,
    );
    await expect(readJson(join(packageDir, "package.json"))).resolves.toMatchObject({
      name: "@acme/workflows",
      version: "1.2.3",
    });
    await expect(stat(resolve(cwd, ".trailstep", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("headless package add defaults to project and registers all discovered workflows", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const promptCalls: string[] = [];
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--yes"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt) => {
            promptCalls.push(`select:${prompt}`);
            return "project";
          },
          multiSelect: async (prompt) => {
            promptCalls.push(`multiSelect:${prompt}`);
            return ["review", "release"];
          },
          text: async (prompt) => {
            promptCalls.push(`text:${prompt}`);
            return "";
          },
        },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: {
              workflows: {
                review: "./index.mjs#reviewWorkflow",
                release: "./index.mjs#releaseWorkflow",
              },
            },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            [
              "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
              "export const releaseWorkflow = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installRequests).toEqual([
      { command: "npm", args: expect.arrayContaining(["@acme/workflows@latest"]), cwd },
    ]);
    const config = (await readJson(resolve(cwd, ".trailstep", "config.json"))) as {
      workflows?: Record<string, Record<string, unknown>>;
      workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(config.workflows?.project ?? {})).toEqual(["review", "release"]);
    expect(config.workflows?.project).toMatchObject({
      review: "@acme/workflows#review",
      release: "@acme/workflows#release",
    });
    expect(config.workflowMetadata?.project?.review).toMatchObject({
      kind: "package",
      packageName: "@acme/workflows",
      requestedSpec: "@acme/workflows@latest",
      requestedRange: "latest",
      installScope: "project",
      targetRef: "@acme/workflows#review",
      workflowName: "review",
      exportName: "reviewWorkflow",
    });
    expect(config.workflowMetadata?.project?.release).toMatchObject({
      kind: "package",
      packageName: "@acme/workflows",
      requestedSpec: "@acme/workflows@latest",
      requestedRange: "latest",
      installScope: "project",
      targetRef: "@acme/workflows#release",
      workflowName: "release",
      exportName: "releaseWorkflow",
    });
    expect(promptCalls).toEqual([]);
  });

  it("headless package add fails on registration conflicts", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./existing.mjs" } },
    });

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    await expect(
      command.run(command.parseArgs(["add", "@acme/workflows@latest", "--yes"]) as never, {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async () => "project",
          multiSelect: async () => ["review", "release"],
          text: async () => "",
        },
        packageCommandRunner: async () => {
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: {
              workflows: {
                review: "./index.mjs#reviewWorkflow",
                release: "./index.mjs#releaseWorkflow",
              },
            },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            [
              "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
              "export const releaseWorkflow = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        },
      }),
    ).rejects.toThrow(/conflict|already exists/i);

    const config = (await readJson(resolve(cwd, ".trailstep", "config.json"))) as {
      workflows?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflows?.project?.review).toBe("./existing.mjs");
    expect(config.workflows?.project?.release).toBeUndefined();
  });

  it("prompts to skip or replace selected package workflow conflicts interactively", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: {
          review: "./existing-review.mjs",
          release: "./existing-release.mjs",
        },
      },
    });

    const conflictPrompts: Array<{
      readonly prompt: string;
      readonly choices: readonly string[];
    }> = [];
    const lines: string[] = [];
    const errors: string[] = [];
    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            if (
              prompt ===
              "project/review already exists in project config. What should TrailStep do?"
            ) {
              conflictPrompts.push({ prompt, choices });
              expect(choices).toEqual([
                "Replace existing registration",
                "Skip this workflow",
                "Cancel add",
              ]);
              return "Skip this workflow";
            }
            if (
              prompt ===
              "project/release already exists in project config. What should TrailStep do?"
            ) {
              conflictPrompts.push({ prompt, choices });
              expect(choices).toEqual([
                "Replace existing registration",
                "Skip this workflow",
                "Cancel add",
              ]);
              return "Replace existing registration";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["Select all", "review", "release"]);
            return ["review", "release"];
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
        packageCommandRunner: async () => {
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: {
              workflows: {
                review: "./index.mjs#reviewWorkflow",
                release: "./index.mjs#releaseWorkflow",
              },
            },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            [
              "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
              "export const releaseWorkflow = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(conflictPrompts.map((entry) => entry.prompt)).toEqual([
      "project/review already exists in project config. What should TrailStep do?",
      "project/release already exists in project config. What should TrailStep do?",
    ]);
    const config = (await readJson(resolve(cwd, ".trailstep", "config.json"))) as {
      workflows?: Record<string, Record<string, unknown>>;
      workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflows?.project).toMatchObject({
      review: "./existing-review.mjs",
      release: "@acme/workflows#release",
    });
    expect(config.workflowMetadata?.project?.release).toMatchObject({
      kind: "package",
      packageName: "@acme/workflows",
      requestedSpec: "@acme/workflows@latest",
      requestedRange: "latest",
      installScope: "project",
      targetRef: "@acme/workflows#release",
      workflowName: "release",
      exportName: "releaseWorkflow",
    });
    expect(errors).toContain(
      "Warning: skipped project/review because it already exists in project config. Use --force to replace it.",
    );
    expect(lines).toContain("Summary: registered 1, skipped conflicts 1, skill warnings 0.");
  });

  it("cleans up a fresh package install when conflict resolution cancels add", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(configPath, {
      workflows: { project: { review: "./existing.mjs" } },
    });
    const beforeConfig = await readFile(configPath, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        prompts: {
          select: async (prompt, choices) => {
            if (
              prompt ===
              "project/review already exists in project config. What should TrailStep do?"
            ) {
              expect(choices).toEqual([
                "Replace existing registration",
                "Skip this workflow",
                "Cancel add",
              ]);
              return "Cancel add";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["Select all", "review", "release"]);
            return ["review", "release"];
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
        packageCommandRunner: async () => {
          await writeJson(join(cwd, "package.json"), {
            devDependencies: { "@acme/workflows": "latest" },
          });
          await writeFile(join(cwd, "package-lock.json"), "lockfile\n", "utf8");
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: {
              workflows: {
                review: "./index.mjs#reviewWorkflow",
                release: "./index.mjs#releaseWorkflow",
              },
            },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            [
              "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
              "export const releaseWorkflow = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    await expect(readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, "package-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect([...lines, ...errors].join("\n")).toMatch(
      /Cleanup: rolled back package install for @acme\/workflows in project scope\./,
    );
  });

  it("cleans up a fresh package install when every selected package workflow is skipped", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(configPath, {
      workflows: {
        project: {
          review: "./existing-review.mjs",
          release: "./existing-release.mjs",
        },
      },
    });
    const beforeConfig = await readFile(configPath, "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        prompts: {
          select: async (prompt, choices) => {
            if (
              prompt ===
                "project/review already exists in project config. What should TrailStep do?" ||
              prompt ===
                "project/release already exists in project config. What should TrailStep do?"
            ) {
              expect(choices).toEqual([
                "Replace existing registration",
                "Skip this workflow",
                "Cancel add",
              ]);
              return "Skip this workflow";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["Select all", "review", "release"]);
            return ["review", "release"];
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
        packageCommandRunner: async () => {
          await writeJson(join(cwd, "package.json"), {
            devDependencies: { "@acme/workflows": "latest" },
          });
          await writeFile(join(cwd, "package-lock.json"), "lockfile\n", "utf8");
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: {
              workflows: {
                review: "./index.mjs#reviewWorkflow",
                release: "./index.mjs#releaseWorkflow",
              },
            },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            [
              "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
              "export const releaseWorkflow = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    await expect(readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, "package-lock.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "Warning: skipped project/review because it already exists in project config. Use --force to replace it.",
        "Warning: skipped project/release because it already exists in project config. Use --force to replace it.",
      ]),
    );
    expect(lines).toContain("Summary: registered 0, skipped conflicts 2, skill warnings 0.");
    expect([...lines, ...errors].join("\n")).toMatch(
      /Cleanup: rolled back package install for @acme\/workflows in project scope\./,
    );
  });

  it("preserves a reused package when selection is cancelled", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.2.3",
      type: "module",
      exports: { "./package.json": "./package.json" },
      trailstep: {
        workflows: {
          review: "./index.mjs#reviewWorkflow",
          release: "./index.mjs#releaseWorkflow",
        },
      },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      [
        "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };",
        "export const releaseWorkflow = { id: 'release', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        prompts: {
          select: async (prompt, choices) => {
            if (
              prompt ===
              "Package @acme/workflows is already installed in project scope. What should TrailStep do?"
            ) {
              expect(choices).toEqual(["Reuse installed package", "Reinstall/upgrade", "Cancel"]);
              return "Reuse installed package";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          multiSelect: async (prompt, choices) => {
            expect(prompt).toBe("Bundle workflow");
            expect(choices).toEqual(["Select all", "review", "release"]);
            return [];
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installRequests).toEqual([]);
    await expect(readJson(join(packageDir, "package.json"))).resolves.toMatchObject({
      name: "@acme/workflows",
      version: "1.2.3",
    });
    await expect(readJson(configPath)).rejects.toThrow();
    expect([...lines, ...errors].join("\n")).toMatch(
      /Cleanup: preserved existing package @acme\/workflows in project scope; no package install rollback was run\./,
    );
  });

  it("installs an npm package into project scope before discovering and registering workflows", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          await expect(readJson(join(cwd, "package.json"))).resolves.toMatchObject({});
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installRequests).toEqual([
      { command: "npm", args: expect.arrayContaining(["@acme/workflows@latest"]), cwd },
    ]);
    const config = (await readJson(resolve(cwd, ".trailstep", "config.json"))) as {
      workflows?: Record<string, Record<string, unknown>>;
      workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflows?.project?.review).toBe("@acme/workflows#review");
    expect(config.workflowMetadata?.project?.review).toMatchObject({
      kind: "package",
      sourceType: "npm",
      packageName: "@acme/workflows",
      requestedSpec: "@acme/workflows@latest",
      requestedRange: "latest",
      installScope: "project",
      installOwnership: "trailstep-installed",
    });
    await expect(
      resolveWorkflowReference("project/review", { cwd, homeDir }),
    ).resolves.toMatchObject({ id: "project/review" });
  });

  it("uses the detected package manager when installing package-backed workflows", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installRequests).toEqual([
      {
        command: "pnpm",
        args: ["add", "--save-dev", "--workspace-root", "@acme/workflows@latest"],
        cwd,
      },
    ]);
  });

  it("reports existing package version and records reused ownership metadata", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.2.3",
      type: "module",
      exports: { "./package.json": "./package.json" },
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const lines: string[] = [];
    const selectPrompts: string[] = [];
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            selectPrompts.push(prompt);
            if (
              prompt ===
              "Package @acme/workflows is already installed in project scope. What should TrailStep do?"
            ) {
              expect(choices).toEqual(["Reuse installed package", "Reinstall/upgrade", "Cancel"]);
              return "Reuse installed package";
            }
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(lines).toContain("Package @acme/workflows@1.2.3 is already installed in project scope.");
    expect(lines).toContain("Source type: npm");
    expect(lines).toContain("Requested spec: @acme/workflows@latest");
    expect(lines).toContain(`Install root: ${cwd}`);
    expect(selectPrompts).toContain(
      "Package @acme/workflows is already installed in project scope. What should TrailStep do?",
    );
    expect(installRequests).toEqual([]);
    const config = (await readJson(resolve(cwd, ".trailstep", "config.json"))) as {
      workflows?: Record<string, Record<string, unknown>>;
      workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflows?.project?.review).toBe("@acme/workflows#review");
    expect(config.workflowMetadata?.project?.review).toMatchObject({
      installOwnership: "reused-existing",
    });
  });

  it("reinstalling an already installed package records TrailStep-installed ownership", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.2.3",
      type: "module",
      exports: { "./package.json": "./package.json" },
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (
              prompt ===
              "Package @acme/workflows is already installed in project scope. What should TrailStep do?"
            ) {
              expect(choices).toEqual(["Reuse installed package", "Reinstall/upgrade", "Cancel"]);
              return "Reinstall/upgrade";
            }
            if (prompt === "Add to project skills?" || prompt === "Add to user skills?") {
              return "no";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "2.0.0",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
          });
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installRequests).toEqual([
      { command: "npm", args: expect.arrayContaining(["@acme/workflows@latest"]), cwd },
    ]);
    const config = (await readJson(resolve(cwd, ".trailstep", "config.json"))) as {
      workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflowMetadata?.project?.review).toMatchObject({
      installOwnership: "trailstep-installed",
      resolvedVersion: "2.0.0",
    });
  });

  it("cancels without registration when existing package prompt selects cancel", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.2.3",
      type: "module",
      exports: { "./package.json": "./package.json" },
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          select: async (prompt) => {
            if (
              prompt ===
              "Package @acme/workflows is already installed in project scope. What should TrailStep do?"
            ) {
              return "Cancel";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async (prompt) => {
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
        },
        packageCommandRunner: async () => ({ exitCode: 0 }),
      },
    );

    expect(exitCode).toBe(0);
    await expect(readJson(configPath)).rejects.toThrow();
  });

  it("installs explicit github package refs and records github metadata", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const homeDir = join(cwd, "home");
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];

    const command = resolveCommand(["add", "github:user/repo"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "github:user/repo", "--scope", "project"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installRequests[0]).toMatchObject({ command: "npm", cwd });
    expect(installRequests[0]?.args).toContain("github:user/repo");
    const config = (await readJson(resolve(cwd, ".trailstep", "config.json"))) as {
      workflows?: Record<string, Record<string, unknown>>;
      workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflows?.project?.review).toBe("@acme/workflows#review");
    expect(config.workflowMetadata?.project?.review).toMatchObject({
      kind: "package",
      sourceType: "github",
      packageName: "@acme/workflows",
      requestedSpec: "github:user/repo",
      githubRef: "user/repo",
      installScope: "project",
      targetRef: "@acme/workflows#review",
      workflowName: "review",
      exportName: "reviewWorkflow",
    });
    await expect(
      resolveWorkflowReference("project/review", { cwd, homeDir }),
    ).resolves.toMatchObject({ id: "project/review" });
  });

  it("rejects implicit github shorthand as unsupported", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["add", "user/repo"]);

    await expect(
      command.run(command.parseArgs(["add", "user/repo", "--scope", "project"]) as never, {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).rejects.toThrow(/github:user\/repo|unsupported GitHub shorthand/i);
  });

  it("installs global packages into the user TrailStep package store outside a Node project", async ({
    task,
  }) => {
    const root = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const cwd = join(root, "outside-node-project");
    const homeDir = join(root, "home");
    const packageStore = join(homeDir, ".trailstep", "packages");
    const packageDir = join(packageStore, "node_modules", "@acme", "workflows");
    const installRequests: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
    }> = [];
    await mkdir(cwd, { recursive: true });

    const command = resolveCommand(["add", "@acme/workflows@latest"]);
    const exitCode = await command.run(
      command.parseArgs(["add", "@acme/workflows@latest", "--scope", "global"]) as never,
      {
        cwd,
        homeDir,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async (request) => {
          installRequests.push(request);
          await expect(readJson(join(packageStore, "package.json"))).resolves.toMatchObject({});
          await mkdir(packageDir, { recursive: true });
          await writeJson(join(packageDir, "package.json"), {
            name: "@acme/workflows",
            version: "1.2.3",
            type: "module",
            exports: { "./package.json": "./package.json" },
            trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
          });
          await writeFile(
            join(packageDir, "index.mjs"),
            "export const reviewWorkflow = { id: 'review', start: () => ({ kind: 'done', output: {} }) };\n",
            "utf8",
          );
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(installRequests).toEqual([
      {
        command: "npm",
        args: expect.arrayContaining(["@acme/workflows@latest"]),
        cwd: packageStore,
      },
    ]);
    expect(installRequests[0]?.args).toContain("--save");
    expect(installRequests[0]?.args).not.toContain("--save-dev");
    await expect(stat(join(cwd, "package.json"))).rejects.toThrow();
    expect(await readJson(join(homeDir, ".trailstep", "config.json"))).toMatchObject({
      workflows: { global: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        global: {
          review: {
            kind: "package",
            sourceType: "npm",
            packageName: "@acme/workflows",
            requestedSpec: "@acme/workflows@latest",
            requestedRange: "latest",
            installScope: "global",
            targetRef: "@acme/workflows#review",
            workflowName: "review",
            exportName: "reviewWorkflow",
          },
        },
      },
    });
  });

  it("adds a selected installed package bundle workflow by package ref", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      type: "module",
      exports: { "./package.json": "./package.json" },
      trailstep: { workflows: { review: "./index.mjs#reviewWorkflow" } },
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
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { acme: { review: "@acme/workflows#review" } },
    });
  });

  it("errors with available choices for an invalid --workflow", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      [
        "export const alpha = { id: 'alpha', start: () => ({ kind: 'done', output: {} }) };",
        "export const zebra = { id: 'zebra', start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    await expect(
      command.run(
        command.parseArgs([
          "add",
          "./workflows",
          "--workflow",
          "missing",
          "--scope",
          "project",
          "--namespace",
          "acme",
        ]) as never,
        {
          cwd,
          io: { writeLine: () => undefined, writeError: () => undefined },
        },
      ),
    ).rejects.toThrow(/Workflow not found: missing\. Available workflows: alpha, zebra\./);
  });

  it("fails clearly when an installed bundle package cannot be resolved", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
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

  it("throws before prompting when a bundle manifest declares zero workflows", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const packageDir = join(cwd, "local-workflow-package");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(packageDir, "package.json"), {
      name: "local-workflow-package",
      type: "module",
      trailstep: { workflows: {} },
    });

    const command = resolveCommand(["add", "./local-workflow-package"]);
    let multiSelectCalled = false;
    await expect(
      command.run(
        command.parseArgs([
          "add",
          "./local-workflow-package",
          "--scope",
          "project",
          "--namespace",
          "acme",
        ]) as never,
        {
          cwd,
          io: { writeLine: () => undefined, writeError: () => undefined },
          prompts: {
            select: async (prompt) => {
              throw new Error(`Unexpected select prompt: ${prompt}`);
            },
            multiSelect: async () => {
              multiSelectCalled = true;
              return [];
            },
            text: async () => {
              throw new Error("Unexpected text prompt");
            },
          },
        },
      ),
    ).rejects.toThrow(/No workflows found in \.\/local-workflow-package\./);
    expect(multiSelectCalled).toBe(false);
  });

  it("throws before prompting when a direct barrel file has zero workflow exports", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-add-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, "package.json"), { type: "module" });
    await writeFile(
      join(cwd, "workflows", "index.ts"),
      "export const notAWorkflow = { id: 'not-a-workflow' };",
      "utf8",
    );

    const command = resolveCommand(["add", "./workflows"]);
    let multiSelectCalled = false;
    await expect(
      command.run(
        command.parseArgs([
          "add",
          "./workflows",
          "--scope",
          "project",
          "--namespace",
          "acme",
        ]) as never,
        {
          cwd,
          io: { writeLine: () => undefined, writeError: () => undefined },
          prompts: {
            select: async (prompt) => {
              throw new Error(`Unexpected select prompt: ${prompt}`);
            },
            multiSelect: async () => {
              multiSelectCalled = true;
              return [];
            },
            text: async () => {
              throw new Error("Unexpected text prompt");
            },
          },
        },
      ),
    ).rejects.toThrow(/No workflows found in \.\/workflows\./);
    expect(multiSelectCalled).toBe(false);
  });
});
