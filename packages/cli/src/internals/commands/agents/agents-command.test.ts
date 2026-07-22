import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StepkitCliPrompts } from "../../command.types.js";

import { CliUsageError } from "../../command.types.js";
import { resolveCommand } from "../../command-registry.js";

function tmpDir(task: { readonly id: string }): string {
  return join("node_modules", ".tmp-stepkit-agents-command-tests", `${task.id}-${randomUUID()}`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function scriptedPrompts(
  answers: readonly string[],
  history: { readonly prompt: string; readonly choices: readonly string[] }[],
): StepkitCliPrompts {
  const queue = [...answers];
  return {
    async select(prompt, choices) {
      history.push({ prompt, choices });
      const answer = queue.shift();
      if (answer === undefined) {
        throw new Error(`No scripted answer for ${prompt}`);
      }
      return answer;
    },
    async text(prompt) {
      const answer = queue.shift();
      if (answer === undefined) {
        throw new Error(`No scripted text answer for ${prompt}`);
      }
      return answer;
    },
  };
}

describe("agentsCommand", () => {
  it("routes agents set and replaces the selected project agent with one literal target", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const command = resolveCommand([
      "agents",
      "set",
      "reviewer",
      "--provider",
      "claude",
      "--model",
      "sonnet",
      "--scope",
      "project",
    ]);

    const exitCode = await command.run(
      command.parseArgs([
        "agents",
        "set",
        "reviewer",
        "--provider",
        "claude",
        "--model",
        "sonnet",
        "--scope",
        "project",
      ]) as never,
      { cwd, io: { writeLine: () => undefined, writeError: () => undefined } },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } },
    });
  });

  it("rejects set when required flags or thinking values are invalid", async ({ task }) => {
    const cwd = tmpDir(task);
    const command = resolveCommand(["agents"]);

    expect(() =>
      command.parseArgs([
        "agents",
        "set",
        "reviewer",
        "--provider",
        "claude",
        "--scope",
        "project",
      ]),
    ).toThrow(CliUsageError);
    expect(() =>
      command.parseArgs([
        "agents",
        "set",
        "reviewer",
        "--provider",
        "claude",
        "--model",
        "sonnet",
        "--thinking",
        "huge",
        "--scope",
        "project",
      ]),
    ).toThrow(CliUsageError);

    await expect(readJson(resolve(cwd, ".stepkit", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("shows project raw medium as dash even when user scope defines medium", async ({ task }) => {
    const cwd = tmpDir(task);
    const homeDir = join(cwd, "home");
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {});
    await writeJson(resolve(homeDir, ".stepkit", "config.json"), {
      agents: { medium: { items: [{ provider: "claude", model: "sonnet" }] } },
    });
    const selections: { readonly prompt: string; readonly choices: readonly string[] }[] = [];
    const command = resolveCommand(["agents"]);

    const exitCode = await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      homeDir,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(["Project", "Done"], selections),
    });

    expect(exitCode).toBe(0);
    expect(selections[0]?.choices).toEqual(["Project-local", "Project", "User"]);
    expect(selections[1]?.choices).toContain("medium — dash");
  });

  it("creates a project-scope workflow one-off for a declared workflow role dash row", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await mkdir(resolve(cwd, "workflows"), { recursive: true });
    await writeFile(
      resolve(cwd, "workflows", "release.mjs"),
      "export default { id: 'release', agents: { reviewer: { size: 'medium' } }, start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      workflows: { project: { release: "./workflows/release.mjs" } },
    });
    const selections: { readonly prompt: string; readonly choices: readonly string[] }[] = [];
    const command = resolveCommand(["agents"]);

    const exitCode = await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — dash",
          "Create inline one-off",
          "claude",
          "sonnet",
          "none",
          "Save as one-off",
        ],
        selections,
      ),
    });

    expect(exitCode).toBe(0);
    expect(selections[1]?.choices).toContain("workflow release reviewer — dash");
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } } },
      },
    });
  });

  it("creates a named agent from a workflow role dash row and points the role at it", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await mkdir(resolve(cwd, "workflows"), { recursive: true });
    await writeFile(
      resolve(cwd, "workflows", "release.mjs"),
      "export default { id: 'release', agents: { reviewer: { size: 'medium' } }, start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      workflows: { project: { release: "./workflows/release.mjs" } },
    });
    const selections: { readonly prompt: string; readonly choices: readonly string[] }[] = [];
    const command = resolveCommand(["agents"]);

    const exitCode = await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — dash",
          "Use named agent",
          "+ Create new agent",
          "release-reviewer",
          "claude",
          "sonnet",
          "none",
          "Save as new permanent agent",
        ],
        selections,
      ),
    });

    expect(exitCode).toBe(0);
    expect(selections.find((entry) => entry.prompt === "Named agent")?.choices[0]).toBe(
      "+ Create new agent",
    );
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: { "release-reviewer": { items: [{ provider: "claude", model: "sonnet" }] } },
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { reviewer: { items: [{ ref: "release-reviewer" }] } } },
      },
    });
  });

  it("blocks delete when any raw scope file refers to the agent and leaves the entry unchanged", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const homeDir = join(cwd, "home");
    const projectConfigPath = resolve(cwd, ".stepkit", "config.json");
    await writeJson(projectConfigPath, {
      agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } },
    });
    await writeJson(resolve(homeDir, ".stepkit", "config.json"), {
      workflows: { release: { reviewer: { items: [{ ref: "reviewer" }] } } },
    });

    const command = resolveCommand(["agents", "delete", "reviewer", "--scope", "project"]);

    await expect(
      command.run(
        command.parseArgs(["agents", "delete", "reviewer", "--scope", "project"]) as never,
        { cwd, homeDir, io: { writeLine: () => undefined, writeError: () => undefined } },
      ),
    ).rejects.toThrow("user: workflows.release.reviewer.items[0]");
    expect(await readJson(projectConfigPath)).toEqual({
      agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } },
    });
  });

  it("edits, renames, and deletes named-agent rows from the interactive project scope", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } },
    });
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "reviewer — one-off claude/sonnet",
          "Edit",
          "Edit item 1 — one-off claude/sonnet",
          "codex",
          "gpt-5",
          "none",
          "Done",
          "Save to original",
        ],
        [],
      ),
    });
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: { reviewer: { items: [{ provider: "codex", model: "gpt-5" }] } },
    });

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        ["Project", "reviewer — one-off codex/gpt-5", "Rename", "auditor", "Save to original"],
        [],
      ),
    });
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: { auditor: { items: [{ provider: "codex", model: "gpt-5" }] } },
    });

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        ["Project", "auditor — one-off codex/gpt-5", "Delete", "Save to original"],
        [],
      ),
    });
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({ agents: {} });
  });

  it("blocks interactive named-agent delete when a workflow role still refers to it", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } },
      workflows: { release: { agents: { reviewer: { items: [{ ref: "reviewer" }] } } } },
    });
    const command = resolveCommand(["agents"]);

    await expect(
      command.run(command.parseArgs(["agents"]) as never, {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: scriptedPrompts(["Project", "reviewer — one-off claude/sonnet", "Delete"], []),
      }),
    ).rejects.toThrow("Cannot delete agent reviewer");
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } },
      workflows: { release: { agents: { reviewer: { items: [{ ref: "reviewer" }] } } } },
    });
  });

  it("creates a named agent from the interactive create row only when save is confirmed", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {});
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        ["Project", "+ Create new agent", "draft", "claude", "sonnet", "none", "Discard"],
        [],
      ),
    });
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({});

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "+ Create new agent",
          "reviewer",
          "claude",
          "opus",
          "high",
          "Save as new permanent agent",
        ],
        [],
      ),
    });
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: { reviewer: { items: [{ provider: "claude", model: "opus", thinking: "high" }] } },
    });
  });

  it("updates workflow role ref rows by editing the referenced agent, removing, and replacing the override", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await mkdir(resolve(cwd, "workflows"), { recursive: true });
    await writeFile(
      resolve(cwd, "workflows", "release.mjs"),
      "export default { id: 'release', agents: { reviewer: { size: 'medium' } }, start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: {
        reviewer: { items: [{ provider: "claude", model: "sonnet" }] },
        auditor: { items: [{ provider: "gemini", model: "pro" }] },
      },
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { reviewer: { items: [{ ref: "reviewer" }] } } },
      },
    });
    const selections: { readonly prompt: string; readonly choices: readonly string[] }[] = [];
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — ref reviewer",
          "Edit referenced shared agent",
          "Edit item 1 — one-off claude/sonnet",
          "codex",
          "gpt-5",
          "none",
          "Done",
          "Save to original (shared, affects every other referrer)",
        ],
        [],
      ),
    });
    let config = await readJson(resolve(cwd, ".stepkit", "config.json"));
    expect(config).toMatchObject({
      agents: { reviewer: { items: [{ provider: "codex", model: "gpt-5" }] } },
    });

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — ref reviewer",
          "Remove override",
          "Save to original (shared, affects every other referrer)",
        ],
        [],
      ),
    });
    config = await readJson(resolve(cwd, ".stepkit", "config.json"));
    expect(config).toMatchObject({ workflows: { release: { agents: {} } } });

    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      ...(config as Record<string, unknown>),
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { reviewer: { items: [{ ref: "reviewer" }] } } },
      },
    });
    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — ref reviewer",
          "Replace override",
          "Use named agent",
          "auditor",
          "Save to original (shared, affects every other referrer)",
        ],
        selections,
      ),
    });
    expect(selections.map((entry) => entry.choices)).toContainEqual([
      "Save to original (shared, affects every other referrer)",
      "Create new agent (fork — only this role repoints)",
      "Save as just a workflow agent (detach to one-off)",
      "Discard",
    ]);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      workflows: { release: { agents: { reviewer: { items: [{ ref: "auditor" }] } } } },
    });
  });

  it("updates workflow inline one-off rows by editing, removing, and replacing the override", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await mkdir(resolve(cwd, "workflows"), { recursive: true });
    await writeFile(
      resolve(cwd, "workflows", "release.mjs"),
      "export default { id: 'release', agents: { reviewer: { size: 'medium' } }, start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: { reviewer: { items: [{ provider: "claude", model: "sonnet" }] } },
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { reviewer: { items: [{ provider: "claude", model: "haiku" }] } } },
      },
    });
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — one-off claude/haiku",
          "Edit inline one-off",
          "Edit item 1 — one-off claude/haiku",
          "gemini",
          "pro",
          "none",
          "Done",
          "Save to original (update one-off in place)",
        ],
        [],
      ),
    });
    let config = await readJson(resolve(cwd, ".stepkit", "config.json"));
    expect(config).toMatchObject({
      workflows: {
        release: { agents: { reviewer: { items: [{ provider: "gemini", model: "pro" }] } } },
      },
    });

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — one-off gemini/pro",
          "Replace override",
          "Use named agent",
          "reviewer",
          "Save as one-off",
        ],
        [],
      ),
    });
    config = await readJson(resolve(cwd, ".stepkit", "config.json"));
    expect(config).toMatchObject({
      workflows: { release: { agents: { reviewer: { items: [{ ref: "reviewer" }] } } } },
    });

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — ref reviewer",
          "Remove override",
          "Save to original (shared, affects every other referrer)",
        ],
        [],
      ),
    });
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      workflows: { release: { agents: {} } },
    });
  });

  it("adds a fallback ref item to an inline workflow role one-off via the items-list flow", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await mkdir(resolve(cwd, "workflows"), { recursive: true });
    await writeFile(
      resolve(cwd, "workflows", "release.mjs"),
      "export default { id: 'release', agents: { reviewer: { size: 'medium' } }, start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: { fallback: { items: [{ provider: "gemini", model: "pro" }] } },
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { reviewer: { items: [{ provider: "claude", model: "haiku" }] } } },
      },
    });
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — one-off claude/haiku",
          "Edit inline one-off",
          "Add item",
          "Pick existing agent",
          "fallback",
          "Done",
          "Save to original (update one-off in place)",
        ],
        [],
      ),
    });

    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      workflows: {
        release: {
          agents: {
            reviewer: {
              items: [{ provider: "claude", model: "haiku" }, { ref: "fallback" }],
            },
          },
        },
      },
    });
  });

  it("forks a workflow ref edit into a new named agent and repoints only that role", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await mkdir(resolve(cwd, "workflows"), { recursive: true });
    await writeFile(
      resolve(cwd, "workflows", "release.mjs"),
      "export default { id: 'release', agents: { reviewer: { size: 'medium' } }, start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: { shared: { items: [{ provider: "claude", model: "sonnet" }] } },
      workflows: {
        project: { release: "./workflows/release.mjs" },
        release: { agents: { reviewer: { items: [{ ref: "shared" }] } } },
      },
    });
    const selections: { readonly prompt: string; readonly choices: readonly string[] }[] = [];
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "workflow release reviewer — ref shared",
          "Edit referenced shared agent",
          "Edit item 1 — one-off claude/sonnet",
          "codex",
          "gpt-5",
          "none",
          "Done",
          "Create new agent (fork — only this role repoints)",
          "release-reviewer",
        ],
        selections,
      ),
    });

    expect(selections.map((entry) => entry.choices)).toContainEqual([
      "Save to original (shared, affects every other referrer)",
      "Create new agent (fork — only this role repoints)",
      "Save as just a workflow agent (detach to one-off)",
      "Discard",
    ]);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      agents: {
        shared: { items: [{ provider: "claude", model: "sonnet" }] },
        "release-reviewer": { items: [{ provider: "codex", model: "gpt-5" }] },
      },
      workflows: { release: { agents: { reviewer: { items: [{ ref: "release-reviewer" }] } } } },
    });
  });

  it("edits one item in a multi-item named-agent entry without replacing the whole list", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: {
        chain: {
          description: "kept",
          items: [{ provider: "claude", model: "sonnet" }, { ref: "base" }],
        },
        base: { items: [{ provider: "gemini", model: "pro" }] },
      },
    });
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "chain — one-off claude/sonnet",
          "Edit",
          "Edit item 1 — one-off claude/sonnet",
          "codex",
          "gpt-5",
          "none",
          "Done",
          "Save to original",
        ],
        [],
      ),
    });

    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      agents: {
        chain: {
          description: "kept",
          items: [{ provider: "codex", model: "gpt-5" }, { ref: "base" }],
        },
      },
    });
  });

  it("renames the selected entry and refs across project-local, project, and user without changing literal providers", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const homeDir = join(cwd, "home");
    await writeJson(resolve(cwd, ".stepkit", "config-local.json"), {
      agents: { local: { items: [{ ref: "reviewer" }] } },
    });
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: {
        reviewer: { items: [{ provider: "claude", model: "sonnet" }] },
        providerNamedReviewer: { items: [{ provider: "reviewer", model: "local" }] },
      },
    });
    await writeJson(resolve(homeDir, ".stepkit", "config.json"), {
      workflows: { release: { reviewer: { items: [{ ref: "reviewer" }] } } },
    });

    const command = resolveCommand([
      "agents",
      "rename",
      "reviewer",
      "auditor",
      "--scope",
      "project",
    ]);
    const exitCode = await command.run(
      command.parseArgs(["agents", "rename", "reviewer", "auditor", "--scope", "project"]) as never,
      { cwd, homeDir, io: { writeLine: () => undefined, writeError: () => undefined } },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config-local.json"))).toEqual({
      agents: { local: { items: [{ ref: "auditor" }] } },
    });
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: {
        providerNamedReviewer: { items: [{ provider: "reviewer", model: "local" }] },
        auditor: { items: [{ provider: "claude", model: "sonnet" }] },
      },
    });
    expect(await readJson(resolve(homeDir, ".stepkit", "config.json"))).toEqual({
      workflows: { release: { reviewer: { items: [{ ref: "auditor" }] } } },
    });
  });

  it("adds a second fallback item to a single-item named-agent entry, picking an existing agent as a ref", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: {
        reviewer: { items: [{ provider: "claude", model: "sonnet" }] },
        base: { items: [{ provider: "gemini", model: "pro" }] },
      },
    });
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "reviewer — one-off claude/sonnet",
          "Edit",
          "Add item",
          "Pick existing agent",
          "base",
          "Done",
          "Save to original",
        ],
        [],
      ),
    });

    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      agents: {
        reviewer: { items: [{ provider: "claude", model: "sonnet" }, { ref: "base" }] },
      },
    });
  });

  it("reorders items in a multi-item named-agent entry", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: {
        chain: {
          items: [{ provider: "claude", model: "sonnet" }, { ref: "base" }],
        },
        base: { items: [{ provider: "gemini", model: "pro" }] },
      },
    });
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "chain — one-off claude/sonnet",
          "Edit",
          "Move item 1 down",
          "Done",
          "Save to original",
        ],
        [],
      ),
    });

    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      agents: {
        chain: { items: [{ ref: "base" }, { provider: "claude", model: "sonnet" }] },
      },
    });
  });

  it("drills into a ref item inside a chain and edits the referenced agent directly", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".stepkit", "config.json"), {
      agents: {
        chain: {
          items: [{ provider: "claude", model: "sonnet" }, { ref: "base" }],
        },
        base: { items: [{ provider: "gemini", model: "pro" }] },
      },
    });
    const command = resolveCommand(["agents"]);

    await command.run(command.parseArgs(["agents"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: scriptedPrompts(
        [
          "Project",
          "chain — one-off claude/sonnet",
          "Edit",
          "Edit item 2 — ref base",
          "Edit item 1 — one-off gemini/pro",
          "codex",
          "gpt-5",
          "none",
          "Done",
          "Save to original",
          "Done",
          "Save to original",
        ],
        [],
      ),
    });

    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toMatchObject({
      agents: {
        chain: { items: [{ provider: "claude", model: "sonnet" }, { ref: "base" }] },
        base: { items: [{ provider: "codex", model: "gpt-5" }] },
      },
    });
  });
});
