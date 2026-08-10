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
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
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
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config-local.json"))).toEqual({
      customProviders: { "local-agent": { binary: "agent-bin" } },
      agents: {
        default: [{ provider: "claude", model: "opus" }],
        reviewer: [{ provider: "local-agent" }],
      },
    });
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
