import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../command-registry.js";

function tmpDir(task: { readonly id: string }): string {
  return join("node_modules", ".tmp-trailstep-providers-command-tests", `${task.id}-${randomUUID()}`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const validManifest = {
  schemaVersion: 1,
  id: "my-agent",
  displayName: "My Agent",
  working: {
    supported: true,
    command: "my-agent",
    args: ["--prompt", "{{promptFile}}", "--output", "{{outputFile}}"],
    prompt: { kind: "prompt-file" },
    output: { style: "provider-output-file" },
  },
  interactive: { supported: false, reason: "Working-agent only." },
  model: { supported: false },
  thinking: { supported: true, levels: ["low", "medium"] },
} as const;

describe("providersCommand", () => {
  it("adds a valid local manifest registration to project config", async ({ task }) => {
    const cwd = tmpDir(task);
    const manifestPath = resolve(cwd, "providers", "my-agent.trailstep-provider.json");
    await writeJson(manifestPath, validManifest);
    const command = resolveCommand(["providers", "add", manifestPath, "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "add", manifestPath, "--scope", "project"]) as never,
      { cwd, io: { writeLine: () => undefined, writeError: () => undefined } },
    );

    expect(exitCode).toBe(0);
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: manifestPath },
          manifest: validManifest,
        },
      },
    });
  });

  it("inspect reports actionable diagnostics for an invalid manifest without registering it", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const errors: string[] = [];
    const manifestPath = resolve(cwd, "providers", "bad.trailstep-provider.json");
    await writeJson(manifestPath, {
      schemaVersion: 1,
      id: "bad-agent",
      displayName: "Bad Agent",
      working: { supported: true },
      interactive: { supported: false },
      model: { supported: false },
      thinking: { supported: false },
    });
    const command = resolveCommand(["providers", "inspect", manifestPath]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(command.parseArgs(["providers", "inspect", manifestPath]) as never, {
      cwd,
      io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("manifest.working.command must be a non-empty string");
    expect(errors.join("\n")).toContain("manifest.working.prompt.kind must be prompt-file");
    await expect(readJson(resolve(cwd, ".trailstep", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("list reports whether registered providers declare hooks", async ({ task }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await writeJson(configPath, {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: {
            ...validManifest,
            hooks: {
              beforeWorkingAgent: { supported: true },
            },
          },
        },
      },
    });
    const lines: string[] = [];
    const command = resolveCommand(["providers", "list", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "list", "--scope", "project"]) as never,
      { cwd, io: { writeLine: (line) => lines.push(line), writeError: () => undefined } },
    );

    expect(exitCode).toBe(0);
    expect(lines).toContain("my-agent\tMy Agent\tlocal-manifest\thooks: yes");
  });

  it("remove reports agents that reference a provider and leaves config unchanged", async ({ task }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    const originalConfig = {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: validManifest,
        },
      },
      agents: {
        reviewer: [{ provider: "my-agent" }],
      },
    };
    await writeJson(configPath, originalConfig);
    const errors: string[] = [];
    const command = resolveCommand(["providers", "remove", "my-agent", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "remove", "my-agent", "--scope", "project"]) as never,
      { cwd, io: { writeLine: () => undefined, writeError: (line) => errors.push(line) } },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("agents.reviewer[0]");
    expect(await readJson(configPath)).toEqual(originalConfig);
  });
});
