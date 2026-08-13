import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../command-registry.js";
import { workflowsCommand } from "./workflows-command.js";

function tmpDir(task: { readonly id: string }): string {
  return join(
    "node_modules",
    ".tmp-trailstep-workflows-command-tests",
    `${task.id}-${randomUUID()}`,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("workflowsCommand", () => {
  it("routes trailstep workflows through command-registry", () => {
    const command = resolveCommand(["workflows"]);
    expect(command.parseArgs(["workflows"])).toEqual({});
  });

  it("rejects unknown options", () => {
    expect(() => workflowsCommand.parseArgs(["workflows", "--edit"])).toThrow(
      /Unknown option for trailstep workflows/,
    );
  });

  it("prints a message and any discoverable packages when there is nothing registered", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
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

    const lines: string[] = [];
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      "No registered workflows to edit.",
      "@acme/trailstep-workflows:reviewFeature",
    ]);
  });

  it("requires an interactive session when workflows are registered", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    await expect(
      workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
        cwd,
        homeDir: tmpDir(task),
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).rejects.toThrow(/requires an interactive session/);
  });

  it("prints registered entries grouped by scope, then discoverable packages, before prompting", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const homeDir = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, ".trailstep", "config-local.json"), {
      workflows: { project: { scratch: "./scratch.mjs" } },
    });
    await writeJson(join(homeDir, ".trailstep", "config.json"), {
      workflows: { deploy: { prod: "./deploy.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    let sawExpectedChoices = false;
    await expect(
      workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
        cwd,
        homeDir,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        prompts: {
          select: async (_prompt, choices) => {
            expect(choices).toEqual([
              "local: project/scratch -> ./scratch.mjs",
              "project: project/review -> ./review.mjs",
              "global: deploy/prod -> ./deploy.mjs",
            ]);
            sawExpectedChoices = true;
            throw new Error("stop after selection assertion");
          },
          text: async () => {
            throw new Error("Unexpected text prompt.");
          },
        },
      }),
    ).rejects.toThrow("stop after selection assertion");

    expect(sawExpectedChoices).toBe(true);
    expect(lines).toEqual([
      "local:",
      "  project/scratch -> ./scratch.mjs",
      "project (shared):",
      "  project/review -> ./review.mjs",
      "global:",
      "  deploy/prod -> ./deploy.mjs",
    ]);
  });

  it("prints package metadata for project package-backed registrations", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        project: {
          review: {
            kind: "package",
            sourceType: "npm",
            packageName: "@acme/workflows",
            requestedSpec: "@acme/workflows@^1.2.0",
            requestedRange: "^1.2.0",
            installScope: "project",
            targetRef: "@acme/workflows#review",
            workflowName: "review",
            exportName: "reviewWorkflow",
            installOwnership: "trailstep-installed",
          },
        },
      },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    let choicesAtPrompt: readonly string[] = [];
    await expect(
      workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
        cwd,
        homeDir: tmpDir(task),
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Select a workflow to edit") {
              choicesAtPrompt = choices;
              throw new Error("stop after workflow selection prompt");
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async () => {
            throw new Error("Unexpected text prompt.");
          },
        },
      }),
    ).rejects.toThrow("stop after workflow selection prompt");

    const projectLine =
      lines.find((line) => line.includes("project/review -> @acme/workflows#review")) ?? "";
    expect(projectLine).toContain("sourceType: npm");
    expect(projectLine).toContain("packageName: @acme/workflows");
    expect(projectLine).toContain("requestedSpec: @acme/workflows@^1.2.0");
    expect(projectLine).toContain("installScope: project");
    expect(projectLine).toContain("installOwnership: trailstep-installed");

    const promptLabel =
      choicesAtPrompt.find((choice) =>
        choice.includes("project/review -> @acme/workflows#review"),
      ) ?? "";
    expect(promptLabel).toContain("sourceType: npm");
    expect(promptLabel).toContain("packageName: @acme/workflows");
  });

  it("prints package metadata for global package-backed registrations", async ({ task }) => {
    const cwd = tmpDir(task);
    const homeDir = tmpDir(task);
    await writeJson(join(homeDir, ".trailstep", "config.json"), {
      workflows: { global: { deploy: "@acme/workflows#deploy" } },
      workflowMetadata: {
        global: {
          deploy: {
            kind: "package",
            sourceType: "github",
            packageName: "@acme/workflows",
            requestedSpec: "github:acme/workflows",
            requestedRange: "github:acme/workflows",
            installScope: "global",
            targetRef: "@acme/workflows#deploy",
            workflowName: "deploy",
            exportName: "deployWorkflow",
            githubRef: "acme/workflows",
            installOwnership: "reused-existing",
          },
        },
      },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    let choicesAtPrompt: readonly string[] = [];
    await expect(
      workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
        cwd,
        homeDir,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        prompts: {
          select: async (prompt, choices) => {
            if (prompt === "Select a workflow to edit") {
              choicesAtPrompt = choices;
              throw new Error("stop after workflow selection prompt");
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          text: async () => {
            throw new Error("Unexpected text prompt.");
          },
        },
      }),
    ).rejects.toThrow("stop after workflow selection prompt");

    const globalLine =
      lines.find((line) => line.includes("global/deploy -> @acme/workflows#deploy")) ?? "";
    expect(globalLine).toContain("sourceType: github");
    expect(globalLine).toContain("packageName: @acme/workflows");
    expect(globalLine).toContain("requestedSpec: github:acme/workflows");
    expect(globalLine).toContain("installScope: global");
    expect(globalLine).toContain("installOwnership: reused-existing");
    expect(globalLine).toContain("githubRef: acme/workflows");

    const promptLabel =
      choicesAtPrompt.find((choice) =>
        choice.includes("global/deploy -> @acme/workflows#deploy"),
      ) ?? "";
    expect(promptLabel).toContain("sourceType: github");
    expect(promptLabel).toContain("installScope: global");
  });

  it("falls back to simple target refs when package metadata target is stale", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/workflows#review" } },
      workflowMetadata: {
        project: {
          review: {
            kind: "package",
            sourceType: "npm",
            packageName: "@acme/workflows",
            requestedSpec: "@acme/workflows@^1.2.0",
            requestedRange: "^1.2.0",
            installScope: "project",
            targetRef: "@acme/workflows#old-review",
            workflowName: "review",
            exportName: "reviewWorkflow",
            installOwnership: "trailstep-installed",
          },
        },
      },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    let choicesAtPrompt: readonly string[] = [];
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            choicesAtPrompt = choices;
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            return "Exit";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(choicesAtPrompt).toEqual(["project: project/review -> @acme/workflows#review"]);
    expect(lines).toContain("  project/review -> @acme/workflows#review");
    expect(lines).toContain("@acme/workflows#review");
    expect(lines.some((line) => line.includes("sourceType: npm"))).toBe(false);
    expect(lines.some((line) => line.includes("@acme/workflows#old-review"))).toBe(false);
  });

  it("drills into a workflow, edits its namespace, then returns to page B", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    let pageBVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            pageBVisits += 1;
            return pageBVisits === 1 ? "Namespace: project" : "Exit";
          }
          if (prompt === "New namespace") {
            return "Type a new namespace...";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async (prompt) => {
          if (prompt === "New namespace") {
            return "acme";
          }
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toContain("./review.mjs");
    expect(lines).toContain("Renamed project: project/review -> acme/review");
    const config = JSON.parse(
      await readFile(join(cwd, ".trailstep", "config.json"), "utf8"),
    ) as unknown;
    expect(config).toEqual({ workflows: { acme: { review: "./review.mjs" } } });
  });

  it("edits the name via a free-text prompt and writes immediately", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    let pageBVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            pageBVisits += 1;
            return pageBVisits === 1 ? "Name: review" : "Exit";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async (prompt) => {
          if (prompt === "New name") {
            return "reviewed";
          }
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toContain("Renamed project: project/review -> project/reviewed");
    const config = JSON.parse(
      await readFile(join(cwd, ".trailstep", "config.json"), "utf8"),
    ) as unknown;
    expect(config).toEqual({ workflows: { project: { reviewed: "./review.mjs" } } });
  });

  it("renames package-backed workflow metadata with the selected registration", async ({
    task,
  }) => {
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
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    let actionMenuVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            actionMenuVisits += 1;
            return actionMenuVisits === 1 ? "Name: review" : "Exit";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async (prompt) => {
          if (prompt === "New name") {
            return "renamed";
          }
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    const config = (await readJson(join(cwd, ".trailstep", "config.json"))) as {
      readonly workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflowMetadata?.project?.renamed).toMatchObject({
      packageName: "@acme/workflows",
    });
    expect(config.workflowMetadata?.project?.review).toBeUndefined();
  });

  it("removes package-backed workflow metadata with the selected registration", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: { review: "@acme/workflows#review", scratch: "./scratch.mjs" },
      },
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
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    let workflowListVisits = 0;
    let actionMenuVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            workflowListVisits += 1;
            return workflowListVisits === 1
              ? (choices[0] as string)
              : "project: project/scratch -> ./scratch.mjs";
          }
          if (prompt === "Select an action") {
            actionMenuVisits += 1;
            return actionMenuVisits === 1 ? "Remove" : "Exit";
          }
          if (prompt === "Remove project: project/review? This cannot be undone.") {
            return "yes";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    const config = (await readJson(join(cwd, ".trailstep", "config.json"))) as {
      readonly workflowMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(config.workflowMetadata?.project?.review).toBeUndefined();
  });

  it("removes a selected workflow after confirmation and returns to the list", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs", scratch: "./scratch.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    let workflowListVisits = 0;
    let actionMenuVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            workflowListVisits += 1;
            if (workflowListVisits === 1) {
              return choices[0] as string;
            }
            return "project: project/scratch -> ./scratch.mjs";
          }
          if (prompt === "Select an action") {
            actionMenuVisits += 1;
            expect(choices).toContain("Remove");
            return actionMenuVisits === 1 ? "Remove" : "Exit";
          }
          if (prompt === "Remove project: project/review? This cannot be undone.") {
            return "yes";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(workflowListVisits).toBe(2);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { scratch: "./scratch.mjs" } },
    });
  });

  it("keeps config unchanged when remove confirmation is declined", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    let actionMenuVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            actionMenuVisits += 1;
            return actionMenuVisits === 1 ? "Remove" : "Exit";
          }
          if (prompt === "Remove project: project/review? This cannot be undone.") {
            return "no";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(actionMenuVisits).toBe(2);
    expect(await readJson(join(cwd, ".trailstep", "config.json"))).toEqual({
      workflows: { project: { review: "./review.mjs" } },
    });
  });

  it("warns that an existing generated skill directory was not removed", async ({ task }) => {
    const cwd = tmpDir(task);
    const skillDirectory = join(cwd, ".trailstep", "skills", "trst-review");
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });
    await mkdir(skillDirectory, { recursive: true });

    const errors: string[] = [];
    let actionMenuVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            actionMenuVisits += 1;
            return actionMenuVisits === 1 ? "Remove" : "Exit";
          }
          if (prompt === "Remove project: project/review? This cannot be undone.") {
            return "yes";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([
      `Note: skill directory ${skillDirectory} was not removed; delete it manually if desired.`,
    ]);
    await expect(stat(skillDirectory)).resolves.toBeTruthy();
  });

  it("returns to the workflow list on 'Back to workflow list' and re-lists entries", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    let pageBVisits = 0;
    let workflowListVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            workflowListVisits += 1;
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            pageBVisits += 1;
            return pageBVisits <= 2 ? "Back to workflow list" : "Exit";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(workflowListVisits).toBe(3);
  });

  it("asks to overwrite and aborts cleanly on 'no' when the destination already exists", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: {
        project: { review: "./review.mjs", scratch: "./scratch.mjs" },
      },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    let pageBVisits = 0;
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
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
          if (prompt === "Select an action") {
            pageBVisits += 1;
            return pageBVisits === 1 ? "Name: review" : "Exit";
          }
          expect(prompt).toContain("project/scratch already exists");
          return "no";
        },
        text: async (prompt) => {
          if (prompt === "New name") {
            return "scratch";
          }
          throw new Error(`Unexpected prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toContain("Cancelled.");
    const config = JSON.parse(
      await readFile(join(cwd, ".trailstep", "config.json"), "utf8"),
    ) as unknown;
    expect(config).toEqual({
      workflows: {
        project: { review: "./review.mjs", scratch: "./scratch.mjs" },
      },
    });
  });

  it("shows the target ref and a dimmed description (or placeholder) on page B", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "review.mjs"),
      "export const reviewFeature = { id: 'reviewFeature', description: 'Reviews things.', inputShape: {}, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            return "Exit";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toContain("./review.mjs");
    expect(lines).toContain("\x1b[2mReviews things.\x1b[22m");
  });

  it("shows a placeholder when the workflow has no description", async ({ task }) => {
    const cwd = tmpDir(task);
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "review.mjs"),
      "export const reviewFeature = { id: 'reviewFeature', inputShape: {}, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, "package.json"), { name: "consumer" });

    const lines: string[] = [];
    const exitCode = await workflowsCommand.run(workflowsCommand.parseArgs(["workflows"]), {
      cwd,
      homeDir: tmpDir(task),
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        select: async (prompt, choices) => {
          if (prompt === "Select a workflow to edit") {
            return choices[0] as string;
          }
          if (prompt === "Select an action") {
            return "Exit";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        text: async () => {
          throw new Error("Unexpected text prompt.");
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toContain("\x1b[2m(no description)\x1b[22m");
  });
});
