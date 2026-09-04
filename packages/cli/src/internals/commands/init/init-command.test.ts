import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CliUsageError } from "../../command.types.js";
import { resolveCommand } from "../../command-registry.js";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeProviderPackage(
  packageRoot: string,
  options: {
    readonly packageName: string;
    readonly version: string;
    readonly manifest: unknown;
  },
): Promise<void> {
  await writeJson(resolve(packageRoot, "package.json"), {
    name: options.packageName,
    version: options.version,
    type: "module",
    exports: "./index.mjs",
  });
  await writeFile(
    resolve(packageRoot, "index.mjs"),
    `export const trailstepProvider = { manifest: ${JSON.stringify(options.manifest)} };\n`,
    "utf8",
  );
}

async function packagedSkillMarker(target: "project" | "user"): Promise<Record<string, string>> {
  const skillMarkdown = await readFile(resolve("trailstep-skill/SKILL.md"));
  return {
    source: "@trailstep/cli/trailstep-skill",
    target,
    contentHash: `sha256:${createHash("sha256").update(skillMarkdown).digest("hex")}`,
  };
}

const WORKING_ARGS_PROMPT =
  "Working/print-mode args JSON array (blank for TrailStep defaults; placeholders: {{promptFile}}, {{outputFile}}, {{#model}}...{{/model}}, {{#thinking}}...{{/thinking}})";
const INTERACTIVE_ARGS_PROMPT =
  "Interactive args JSON array (blank for TrailStep defaults; placeholders: {{promptFile}}, {{prompt}}, {{#model}}...{{/model}}, {{#thinking}}...{{/thinking}})";

describe("initCommand", () => {
  it("offers official provider packages with add guidance and registers the selected provider", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project"]);
    const lines: string[] = [];
    const packageCommands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const piManifest = {
      schemaVersion: 1,
      id: "pi",
      displayName: "Pi",
      working: {
        supported: true,
        command: "pi",
        args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
        prompt: { kind: "prompt-file" },
        output: { style: "provider-output-file" },
      },
      interactive: { supported: false, reason: "Working-agent only." },
      model: {
        supported: true,
        discovery: {
          command: "pi",
          args: ["--list-models"],
          outputParser: "pi-list-models-table",
        },
      },
      thinking: { supported: true, levels: ["low", "medium", "high", "xhigh", "max"] },
    };

    const exitCode = await command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        async text(prompt) {
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
        async select(prompt, choices) {
          if (prompt === "Provider") {
            expect(choices).toContain("@trailstep/provider-pi");
            expect(choices).toContain("@trailstep/provider-claude");
            expect(choices).toContain("@trailstep/provider-codex");
            expect(choices).toContain("@trailstep/provider-gemini");
            expect(choices).not.toContain("claude");
            expect(choices).not.toContain("codex");
            expect(choices).not.toContain("gemini");
            expect(choices).not.toContain("pi");
            expect(choices.join("\n")).not.toMatch(/detected|not detected/i);
            return "@trailstep/provider-pi";
          }
          if (prompt === "Model override") {
            return "Use provider default";
          }
          if (prompt === "Reasoning/thinking override") {
            return "Use provider default";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the TrailStep usage/authoring skill?") {
            return false;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
      packageCommandRunner: async (request) => {
        packageCommands.push(request);
        await writeProviderPackage(
          resolve(request.cwd, "node_modules", "@trailstep", "provider-pi"),
          {
            packageName: "@trailstep/provider-pi",
            version: "1.0.0",
            manifest: piManifest,
          },
        );
        return { exitCode: 0, stdout: "added @trailstep/provider-pi@1.0.0" };
      },
    });

    expect(exitCode).toBe(0);
    expect(packageCommands).toHaveLength(1);
    expect(packageCommands[0]?.args).toContain("@trailstep/provider-pi");
    expect(lines.join("\n")).toContain(
      "Don't see your provider? Add any TrailStep-compatible provider manifest/package with trailstep providers add <path-or-package>.",
    );
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      providers: {
        pi: {
          source: {
            type: "npm",
            packageName: "@trailstep/provider-pi",
            spec: "@trailstep/provider-pi",
            resolvedVersion: "1.0.0",
          },
          manifest: piManifest,
        },
      },
      agents: { default: [{ provider: "pi" }] },
    });
  });

  it("uses the shared provider-default-first agent setup flow", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project"]);
    const selections: { readonly prompt: string; readonly choices: readonly string[] }[] = [];

    const exitCode = await command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        async text(prompt) {
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
        async select(prompt, choices) {
          selections.push({ prompt, choices });
          if (prompt === "Provider") {
            expect(choices).toContain("@trailstep/provider-claude");
            return "claude";
          }
          if (prompt === "Model override") {
            expect(choices[0]).toBe("Use provider default");
            return "Use provider default";
          }
          if (prompt === "Reasoning/thinking override") {
            expect(choices[0]).toBe("Use provider default");
            return "Use provider default";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the TrailStep usage/authoring skill?") {
            return false;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(selections.map((entry) => entry.prompt)).toEqual([
      "Provider",
      "Model override",
      "Reasoning/thinking override",
    ]);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      agents: { default: [{ provider: "claude" }] },
    });
  });

  it("init uses provider-aware thinking choices from shared setup", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project"]);

    const exitCode = await command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        async text(prompt) {
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
        async select(prompt, choices) {
          if (prompt === "Provider") {
            expect(choices).toContain("@trailstep/provider-codex");
            return "codex";
          }
          if (prompt === "Model override") {
            expect(choices).toEqual(["Use provider default", "Type manually"]);
            return "Use provider default";
          }
          if (prompt === "Reasoning/thinking override") {
            expect(choices).toEqual(["Use provider default", "low", "medium", "high", "xhigh"]);
            expect(choices).not.toContain("max");
            return "xhigh";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the TrailStep usage/authoring skill?") {
            return false;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      agents: { default: [{ provider: "codex", thinking: "xhigh" }] },
    });
  });

  it("init writes improved custom provider config from shared setup", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project"]);

    const exitCode = await command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: () => undefined },
      prompts: {
        async text(prompt) {
          if (prompt === "Custom provider name") {
            return "local-agent";
          }
          if (prompt === "Custom provider binary") {
            return "agent-bin";
          }
          if (prompt === WORKING_ARGS_PROMPT) {
            return "";
          }
          if (prompt === INTERACTIVE_ARGS_PROMPT) {
            return "";
          }
          throw new Error(`Unexpected text prompt: ${prompt}`);
        },
        async select(prompt, choices) {
          if (prompt === "Provider") {
            expect(choices).toContain("custom");
            return "custom";
          }
          if (prompt === "Prompt input style") {
            expect(choices).toEqual(["Prompt file path ({{promptFile}})"]);
            return "Prompt file path ({{promptFile}})";
          }
          if (prompt === "Output style") {
            expect(choices).toEqual(["Output file path ({{outputFile}})"]);
            return "Output file path ({{outputFile}})";
          }
          if (prompt === "Model override") {
            expect(choices).toEqual(["Use provider default", "Type manually"]);
            return "Use provider default";
          }
          if (prompt === "Reasoning/thinking override") {
            expect(choices).toEqual(["Use provider default", "low", "high"]);
            return "Use provider default";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async multiSelect(prompt, choices) {
          if (prompt === "Supported thinking levels") {
            expect(choices).toEqual(["low", "medium", "high", "xhigh", "max"]);
            return ["low", "high"];
          }
          throw new Error(`Unexpected multiSelect prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Custom provider supports interactive steps?") {
            return true;
          }
          if (prompt === "Custom provider supports model overrides?") {
            return true;
          }
          if (prompt === "Custom provider supports thinking overrides?") {
            return true;
          }
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the TrailStep usage/authoring skill?") {
            return false;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      customProviders: {
        "local-agent": {
          binary: "agent-bin",
          args: [
            "--prompt-file",
            "{{promptFile}}",
            "--output-file",
            "{{outputFile}}",
            "{{#model}}",
            "--model",
            "{{model}}",
            "{{/model}}",
            "{{#thinking}}",
            "--thinking",
            "{{thinking}}",
            "{{/thinking}}",
          ],
          interactiveArgs: [
            "--prompt-file",
            "{{promptFile}}",
            "{{#model}}",
            "--model",
            "{{model}}",
            "{{/model}}",
            "{{#thinking}}",
            "--thinking",
            "{{thinking}}",
            "{{/thinking}}",
          ],
          model: { supported: true },
          thinking: { supported: true, levels: ["low", "high"] },
        },
      },
      agents: { default: [{ provider: "local-agent" }] },
    });
  });

  it("routes init and writes a default literal target to the selected project config", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
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
            expect(choices).toContain("@trailstep/provider-claude");
            return "claude";
          }
          if (prompt === "Model override") {
            expect(choices).toEqual(["Use provider default", "Type manually"]);
            return "Type manually";
          }
          if (prompt === "Reasoning/thinking override") {
            expect(choices).toEqual([
              "Use provider default",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ]);
            return "Use provider default";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the TrailStep usage/authoring skill?") {
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
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init"]);
    const textAnswers = ["opus", "reviewer", "local-agent", "agent-bin", ""];
    const providerAnswers = ["claude", "custom"];
    const modelOverrideAnswers = ["Type manually"];
    const configureAnotherAnswers = [true, false];
    let currentProvider = "";

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
            WORKING_ARGS_PROMPT,
          ]).toContain(prompt);
          return textAnswers.shift() ?? "";
        },
        async select(prompt, choices) {
          if (prompt === "Where should agent config be written?") {
            expect(choices).toEqual(["local", "project", "global"]);
            return "local";
          }
          if (prompt === "Provider" && choices.includes("custom")) {
            currentProvider = providerAnswers.shift() ?? "claude";
            return currentProvider;
          }
          if (prompt === "Prompt input style") {
            expect(choices).toEqual(["Prompt file path ({{promptFile}})"]);
            return "Prompt file path ({{promptFile}})";
          }
          if (prompt === "Output style") {
            expect(choices).toEqual(["Output file path ({{outputFile}})"]);
            return "Output file path ({{outputFile}})";
          }
          if (prompt === "Model override") {
            expect(currentProvider).not.toBe("custom");
            expect(choices).toEqual(["Use provider default", "Type manually"]);
            return modelOverrideAnswers.shift() ?? "Use provider default";
          }
          if (prompt === "Reasoning/thinking override") {
            expect(currentProvider).not.toBe("custom");
            expect(choices[0]).toBe("Use provider default");
            return "Use provider default";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          if (prompt === "Configure another agent?") {
            return configureAnotherAnswers.shift() ?? false;
          }
          if (prompt === "Custom provider supports interactive steps?") {
            return false;
          }
          if (prompt === "Custom provider supports model overrides?") {
            return false;
          }
          if (prompt === "Custom provider supports thinking overrides?") {
            return false;
          }
          if (prompt === "Install the TrailStep usage/authoring skill?") {
            return false;
          }
          throw new Error(`Unexpected confirm prompt: ${prompt}`);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config-local.json"))).toEqual({
      customProviders: {
        "local-agent": {
          binary: "agent-bin",
          args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
          model: { supported: false },
          thinking: { supported: false },
        },
      },
      agents: {
        default: [{ provider: "claude", model: "opus" }],
        reviewer: [{ provider: "local-agent" }],
      },
    });
  });

  it("prompts interactively to install the TrailStep usage skill when no skill flag is passed", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
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
          if (prompt === "Model override") {
            return "Type manually";
          }
          if (prompt === "Reasoning/thinking override") {
            return "Use provider default";
          }
          throw new Error(`Unexpected select prompt: ${prompt}`);
        },
        async confirm(prompt) {
          confirmPrompts.push(prompt);
          if (prompt === "Configure another agent?") {
            return false;
          }
          if (prompt === "Install the TrailStep usage/authoring skill?") {
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
    expect(confirmPrompts).toContain("Install the TrailStep usage/authoring skill?");
    expect(skillsCalls).toHaveLength(1);
  });

  it("skips project skill installation when the global config already tracks the current skill", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
      "project",
    );
    const homeDir = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
      "home",
    );
    await writeJson(resolve(homeDir, ".trailstep", "config.json"), {
      skillInstallations: { trailstep: await packagedSkillMarker("user") },
    });

    const command = resolveCommand(["init", "--scope", "project"]);
    const confirmPrompts: string[] = [];
    const skillsCalls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = await command.run(command.parseArgs(["init", "--scope", "project"]) as never, {
      cwd,
      homeDir,
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
          if (prompt === "Model override") {
            return "Type manually";
          }
          if (prompt === "Reasoning/thinking override") {
            return "Use provider default";
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
    });

    expect(exitCode).toBe(0);
    expect(confirmPrompts).not.toContain("Install the TrailStep usage/authoring skill?");
    expect(skillsCalls).toHaveLength(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      agents: { default: [{ provider: "claude", model: "sonnet" }] },
    });
  });

  it("skips skill installation without prompting when --no-install-skill is passed", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
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
            if (prompt === "Model override") {
              return "Type manually";
            }
            if (prompt === "Reasoning/thinking override") {
              return "Use provider default";
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
    expect(confirmPrompts).not.toContain("Install the TrailStep usage/authoring skill?");
    expect(skillsCalls).toHaveLength(0);
  });

  it("rejects conflicting --install-skill and --no-install-skill flags", () => {
    const command = resolveCommand(["init", "--install-skill", "--no-install-skill"]);

    expect(() => command.parseArgs(["init", "--install-skill", "--no-install-skill"])).toThrow(
      CliUsageError,
    );
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

  it("installs the packaged TrailStep usage skill when --install-skill is passed", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
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
              expect(choices).toContain("@trailstep/provider-claude");
              return "claude";
            }
            if (prompt === "Model override") {
              expect(choices).toEqual(["Use provider default", "Type manually"]);
              return "Type manually";
            }
            if (prompt === "Reasoning/thinking override") {
              expect(choices).toEqual([
                "Use provider default",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ]);
              return "Use provider default";
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
      expect.stringContaining("trailstep-skill"),
    ]);
    expect(skillsCalls[0]?.args.slice(3)).toEqual(["--agent", "*", "-y"]);
    expect(lines).toContain("Installed TrailStep usage skill.");
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      agents: { default: [{ provider: "claude", model: "sonnet" }] },
      skillInstallations: { trailstep: await packagedSkillMarker("project") },
    });
  });

  it("installs the packaged TrailStep usage skill globally for --scope global", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
      "project",
    );
    const homeDir = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
      "home",
    );
    const command = resolveCommand(["init", "--scope", "global", "--install-skill"]);
    const skillsCalls: Array<{ command: string; args: readonly string[] }> = [];

    const exitCode = await command.run(
      command.parseArgs(["init", "--scope", "global", "--install-skill"]) as never,
      {
        cwd,
        homeDir,
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
            if (prompt === "Model override") {
              return "Type manually";
            }
            if (prompt === "Reasoning/thinking override") {
              return "Use provider default";
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
    expect(skillsCalls[0]?.args.slice(-1)).toEqual(["-g"]);
    expect(await readJson(resolve(homeDir, ".trailstep", "config.json"))).toEqual({
      agents: { default: [{ provider: "claude", model: "sonnet" }] },
      skillInstallations: { trailstep: await packagedSkillMarker("user") },
    });
  });

  it("reports skill installation failures after writing agent config", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-init-command-tests",
      `${task.id}-${randomUUID()}`,
    );
    const command = resolveCommand(["init", "--scope", "project", "--install-skill"]);

    await expect(
      command.run(command.parseArgs(["init", "--scope", "project", "--install-skill"]) as never, {
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
            if (prompt === "Model override") {
              return "Type manually";
            }
            if (prompt === "Reasoning/thinking override") {
              return "Use provider default";
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
        skillsCliProcessRunner: async () => ({ exitCode: 2 }),
      }),
    ).rejects.toThrow(
      "Failed to install TrailStep usage skill after writing TrailStep agent config: skills CLI exited with code 2.",
    );

    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      agents: { default: [{ provider: "claude", model: "sonnet" }] },
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
