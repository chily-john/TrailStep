import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CliUsageError } from "../../command.types.js";
import { resolveCommand } from "../../command-registry.js";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("initCommand", () => {
  it("routes init and writes a default literal target to the selected project config", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project"]);

    const exitCode = await command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        async text(prompt) {
          if (prompt === "Model") {
            return "sonnet";
          }
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
        async select(prompt, choices) {
          if (prompt === "Provider") {
            expect(choices).toContain("claude");
            return "claude";
          }
          if (prompt === "Thinking") {
            expect(choices).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
            return "none";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the StepKit usage/authoring skill?") {
            return false;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config.json"))).toEqual({
      agents: { default: [{ provider: "claude", model: "sonnet" }] },
    });
  });

  it("prompts for scope and configures additional named agents in the same scope", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init"]);
    const textAnswers = ["opus", "reviewer", "local-agent", "agent-bin", ""];
    const confirmAnswers = [true, false];

    const exitCode = await command.run(command.parseArgs(["init"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        async text(prompt) {
          expect([
            "Model",
            "Agent name",
            "Custom provider name",
            "Custom provider binary",
          ]).toContain(prompt);
          return textAnswers.shift() ?? "";
        },
        async select(prompt, choices) {
          if (prompt === "Where should agent config be written?") {
            expect(choices).toEqual(["local", "project", "global"]);
            return "local";
          }
          if (prompt === "Provider" && choices.includes("custom")) {
            return textAnswers.length === 5 ? "claude" : "custom";
          }
          if (prompt === "Thinking") {
            return "none";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Configure another agent?") {
            return confirmAnswers.shift() ?? false;
          }
          if (prompt === "Install the StepKit usage/authoring skill?") {
            return false;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".stepkit", "config-local.json"))).toEqual({
      customProviders: { "local-agent": { binary: "agent-bin" } },
      agents: {
        default: [{ provider: "claude", model: "opus" }],
        reviewer: [{ provider: "local-agent" }],
      },
    });
  });

  it("prompts interactively to install the StepKit usage skill when no skill flag is passed", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project"]);
    const confirmPrompts: string[] = [];
    const skillsCalls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = await command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        async text(prompt) {
          if (prompt === "Model") {
            return "sonnet";
          }
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
        async select(prompt) {
          if (prompt === "Provider") {
            return "claude";
          }
          if (prompt === "Thinking") {
            return "none";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          confirmPrompts.push(prompt);
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the StepKit usage/authoring skill?") {
            return true;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
      skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
      skillsCliProcessRunner: async (commandName, args) => {
        skillsCalls.push({ command: commandName, args });
        return { exitCode: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(confirmPrompts).toContain("Install the StepKit usage/authoring skill?");
    expect(skillsCalls).toHaveLength(1);
  });

  it("skips skill installation without prompting when --no-install-skill is passed", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project", "--no-install-skill"]);
    const confirmPrompts: string[] = [];
    const skillsCalls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = await command.run(
      command.parseArgs(["init", "--scope", "project", "--no-install-skill"]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        prompts: {
          async text(prompt) {
            if (prompt === "Model") {
              return "sonnet";
            }
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
          async select(prompt) {
            if (prompt === "Provider") {
              return "claude";
            }
            if (prompt === "Thinking") {
              return "none";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          async confirm(prompt) {
            confirmPrompts.push(prompt);
            if (prompt === "Configure another agent?") {
              return false;
            }
            throw new Error(`Unexpected confirm prompt: ${prompt}`);
          },
        },
        skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
        skillsCliProcessRunner: async (commandName, args) => {
          skillsCalls.push({ command: commandName, args });
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(confirmPrompts).not.toContain("Install the StepKit usage/authoring skill?");
    expect(skillsCalls).toHaveLength(0);
  });

  it("rejects conflicting --install-skill and --no-install-skill flags", () => {
    const command = resolveCommand(["init", "--install-skill", "--no-install-skill"]);

    expect(() =>
      command.parseArgs(["init", "--install-skill", "--no-install-skill"]),
    ).toThrow(CliUsageError);
  });

  it("does not ask a skill prompt when prompts are unavailable", async () => {
    const command = resolveCommand(["init", "--scope", "project"]);
    const skillsCalls: Array<{ command: string; args: readonly string[] }> = [];

    await expect(
      command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
        cwd: ".",
        io: { writeLine: () => undefined, writeError: () => undefined },
        skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
        skillsCliProcessRunner: async (commandName, args) => {
          skillsCalls.push({ command: commandName, args });
          return { exitCode: 0 };
        },
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
    expect(skillsCalls).toHaveLength(0);
  });

  it("installs the packaged StepKit usage skill when --install-skill is passed", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-stepkit-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project", "--install-skill"]);
    const lines: string[] = [];
    const skillsCalls: Array<{ command: string; args: readonly string[] }> = [];

    expect(() =>
      command.parseArgs(["init", "--scope", "project", "--install-skill"]),
    ).not.toThrow();

    const exitCode = await command.run(
      command.parseArgs(["init", "--scope", "project", "--install-skill"]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        prompts: {
          async text(prompt) {
            if (prompt === "Model") {
              return "sonnet";
            }
            throw new Error(`Unexpected text prompt: ${prompt}`);
          },
          async select(prompt, choices) {
            if (prompt === "Provider") {
              expect(choices).toContain("claude");
              return "claude";
            }
            if (prompt === "Thinking") {
              expect(choices).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
              return "none";
            }
            throw new Error(`Unexpected select prompt: ${prompt}`);
          },
          async confirm(prompt) {
            if (prompt === "Configure another agent?") {
              return false;
            }
            throw new Error(`Unexpected confirm prompt: ${prompt}`);
          },
        },
        skillsCliResolver: async () => "/repo/node_modules/skills/dist/index.js",
        skillsCliProcessRunner: async (commandName, args) => {
          skillsCalls.push({ command: commandName, args });
          return { exitCode: 0 };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(skillsCalls).toHaveLength(1);
    expect(skillsCalls[0]?.command).toBe(process.execPath);
    expect(skillsCalls[0]?.args.slice(0, 3)).toEqual([
      "/repo/node_modules/skills/dist/index.js",
      "add",
      expect.stringContaining("stepkit-skill"),
    ]);
    expect(skillsCalls[0]?.args.slice(3)).toEqual(["--agent", "*", "-y"]);
    expect(lines).toContain("Installed StepKit usage skill.");
  });

  it("rejects omitted scope when prompts are unavailable", async () => {
    const command = resolveCommand(["init"]);

    expect(() => command.parseArgs(["init"])).not.toThrow();
    await expect(
      command.run(command.parseArgs(["init"]) as never, {
        cwd: ".",
        io: { writeLine: () => undefined, writeError: () => undefined },
      }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });
});
