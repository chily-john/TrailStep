import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolveCommand } from "../../command-registry.js";

function tmpDir(task: { readonly id: string }): string {
  return join(
    "node_modules",
    ".tmp-trailstep-providers-command-tests",
    `${task.id}-${randomUUID()}`,
  );
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeProviderPackage(
  packageRoot: string,
  options: {
    readonly packageName?: string;
    readonly version?: string;
    readonly manifest?: unknown;
    readonly hooksExport?: string;
  } = {},
): Promise<void> {
  await writeJson(resolve(packageRoot, "package.json"), {
    name: options.packageName ?? "@example/provider",
    version: options.version ?? "1.2.3",
    type: "module",
    exports: "./index.mjs",
  });
  await writeFile(
    resolve(packageRoot, "index.mjs"),
    `export const trailstepProvider = {\n  manifest: ${JSON.stringify(options.manifest ?? validManifest)},\n  ${options.hooksExport ?? "hooks: { beforeWorkingAgent: async () => undefined }"}\n};\n`,
    "utf8",
  );
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

  it("preserves bare relative local manifest paths instead of treating them as npm refs", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, "provider.json"), validManifest);
    const packageCommandRunner = vi.fn(async () => ({ exitCode: 1 }));
    const command = resolveCommand(["providers", "add", "provider.json", "--scope", "project"]);

    const exitCode = await command.run(
      command.parseArgs(["providers", "add", "provider.json", "--scope", "project"]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner,
      },
    );

    expect(exitCode).toBe(0);
    expect(packageCommandRunner).not.toHaveBeenCalled();
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "provider.json" },
          manifest: validManifest,
        },
      },
    });
  });

  it("inspect loads a provider package export and reports hooks outside the manifest", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const lines: string[] = [];
    const packageRoot = resolve(cwd, "providers", "echo-package");
    await writeProviderPackage(packageRoot, {
      packageName: "@example/trailstep-provider-echo",
      manifest: { ...validManifest, id: "echo", displayName: "Echo Provider" },
    });
    const command = resolveCommand(["providers", "inspect", packageRoot]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "inspect", packageRoot]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(lines).toContain("Id: echo");
    expect(lines).toContain("Display name: Echo Provider");
    expect(lines).toContain("Hooks: present");
    expect(lines.join("\n")).toContain("executes provider package code");
  });

  it("inspect reports the expected provider package export when it is missing", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const errors: string[] = [];
    const packageRoot = resolve(cwd, "providers", "missing-export");
    await writeJson(resolve(packageRoot, "package.json"), {
      name: "@example/missing-export",
      version: "1.0.0",
      type: "module",
      exports: "./index.mjs",
    });
    await writeFile(resolve(packageRoot, "index.mjs"), "export const notAProvider = {};\n", "utf8");
    const command = resolveCommand(["providers", "inspect", packageRoot]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "inspect", packageRoot]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("trailstepProvider");
    expect(errors.join("\n")).toContain("provider export missing");
  });

  it("inspect of an npm-style provider package reuses node_modules without package writes", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const lines: string[] = [];
    await writeProviderPackage(resolve(cwd, "node_modules", "@example", "provider"));
    const packageCommandRunner = vi.fn(async () => ({ exitCode: 1 }));
    const command = resolveCommand(["providers", "inspect", "@example/provider"]);

    const exitCode = await command.run(
      command.parseArgs(["providers", "inspect", "@example/provider"]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        packageCommandRunner,
      },
    );

    expect(exitCode).toBe(0);
    expect(packageCommandRunner).not.toHaveBeenCalled();
    expect(lines).toContain("Id: my-agent");
    await expect(readJson(resolve(cwd, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds an npm-style provider package through the package runner and stores source metadata", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const packageCommandRunner = vi.fn(async (request) => {
      await writeProviderPackage(resolve(request.cwd, "node_modules", "@example", "provider"));
      return { exitCode: 0, stdout: "added @example/provider@1.2.3" };
    });
    const command = resolveCommand([
      "providers",
      "add",
      "@example/provider@^1.2.0",
      "--scope",
      "project",
    ]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs([
        "providers",
        "add",
        "@example/provider@^1.2.0",
        "--scope",
        "project",
      ]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner,
      },
    );

    expect(exitCode).toBe(0);
    expect(packageCommandRunner).toHaveBeenCalled();
    expect(await readJson(resolve(cwd, ".trailstep", "config.json"))).toEqual({
      providers: {
        "my-agent": {
          source: {
            type: "npm",
            packageName: "@example/provider",
            spec: "@example/provider@^1.2.0",
            resolvedVersion: "1.2.3",
          },
          manifest: validManifest,
        },
      },
    });
  });

  it("add warns when the registered provider will execute provider package code through hooks", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const lines: string[] = [];
    const packageCommandRunner = vi.fn(async (request) => {
      await writeProviderPackage(resolve(request.cwd, "node_modules", "@example", "provider"));
      return { exitCode: 0, stdout: "added @example/provider@1.2.3" };
    });
    const command = resolveCommand([
      "providers",
      "add",
      "@example/provider@^1.2.0",
      "--scope",
      "project",
    ]);

    const exitCode = await command.run(
      command.parseArgs([
        "providers",
        "add",
        "@example/provider@^1.2.0",
        "--scope",
        "project",
      ]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        packageCommandRunner,
      },
    );

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("executes provider package code");
  });

  it("does not write a provider registration when package validation fails", async ({ task }) => {
    const cwd = tmpDir(task);
    const errors: string[] = [];
    const packageCommandRunner = vi.fn(async (request) => {
      await writeJson(
        resolve(request.cwd, "node_modules", "@example", "provider", "package.json"),
        {
          name: "@example/provider",
          version: "1.2.3",
          type: "module",
          exports: "./index.mjs",
        },
      );
      await writeFile(
        resolve(request.cwd, "node_modules", "@example", "provider", "index.mjs"),
        "export const notAProvider = {};\n",
        "utf8",
      );
      return { exitCode: 0 };
    });
    const command = resolveCommand(["providers", "add", "@example/provider", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "add", "@example/provider", "--scope", "project"]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        packageCommandRunner,
      },
    );

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("trailstepProvider");
    await expect(readJson(resolve(cwd, ".trailstep", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
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
    const exitCode = await command.run(
      command.parseArgs(["providers", "inspect", manifestPath]) as never,
      {
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      },
    );

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

  it("test reports a missing working binary without running a prompt", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".trailstep", "config.json"), {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: validManifest,
        },
      },
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const workingAgentProcessRunner = vi.fn(async () => ({ exitCode: 0 }));
    const command = resolveCommand(["providers", "test", "my-agent", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "test", "my-agent", "--scope", "project"]) as never,
      {
        cwd,
        io: {
          writeLine: (line: string) => lines.push(line),
          writeError: (line: string) => errors.push(line),
        },
        workingAgentProcessRunner,
        providerBinaryResolver: async (binary: string) => binary !== "my-agent",
      } as never,
    );

    expect(exitCode).toBe(1);
    expect(`${lines.join("\n")}\n${errors.join("\n")}`).toContain(
      "Missing binary for working.command: my-agent",
    );
    expect(workingAgentProcessRunner).not.toHaveBeenCalled();
  });

  it("test reports missing required environment variables declared by the manifest", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".trailstep", "config.json"), {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: {
            ...validManifest,
            environment: { required: ["MY_AGENT_API_KEY"] },
          },
        },
      },
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const command = resolveCommand(["providers", "test", "my-agent", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "test", "my-agent", "--scope", "project"]) as never,
      {
        cwd,
        env: {},
        io: {
          writeLine: (line: string) => lines.push(line),
          writeError: (line: string) => errors.push(line),
        },
        providerBinaryResolver: async () => true,
      } as never,
    );

    expect(exitCode).toBe(1);
    expect(`${lines.join("\n")}\n${errors.join("\n")}`).toContain("MY_AGENT_API_KEY");
  });

  it("test accepts a valid provider, reports hooks, and states prompt execution was skipped", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".trailstep", "config.json"), {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: {
            ...validManifest,
            hooks: { beforeWorkingAgent: { supported: true } },
          },
        },
      },
    });
    const lines: string[] = [];
    const workingAgentProcessRunner = vi.fn(async () => ({ exitCode: 0 }));
    const command = resolveCommand(["providers", "test", "my-agent", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "test", "my-agent", "--scope", "project"]) as never,
      {
        cwd,
        io: { writeLine: (line: string) => lines.push(line), writeError: () => undefined },
        workingAgentProcessRunner,
        providerBinaryResolver: async () => true,
      } as never,
    );

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("Hooks: present");
    expect(lines.join("\n")).toContain("executes provider package code");
    expect(lines.join("\n")).toContain("Prompt execution skipped");
    expect(workingAgentProcessRunner).not.toHaveBeenCalled();
  });

  it("providers without a subcommand selects and shows a registered provider", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".trailstep", "config.json"), {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: validManifest,
        },
        backup: {
          source: { type: "local-manifest", path: "./providers/backup.trailstep-provider.json" },
          manifest: { ...validManifest, id: "backup", displayName: "Backup" },
        },
      },
    });
    const lines: string[] = [];
    const promptLabels: string[] = [];
    const command = resolveCommand(["providers"]);

    const exitCode = await command.run(command.parseArgs(["providers"]) as never, {
      cwd,
      io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      prompts: {
        text: async () => "",
        select: async (label) => {
          promptLabels.push(label);
          return label === "Scope" ? "project" : "backup";
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(promptLabels).toEqual(["Scope", "Provider"]);
    expect(lines).toContain("Id: backup");
    expect(lines).toContain("Display name: Backup");
    expect(lines).toContain("Source: local-manifest ./providers/backup.trailstep-provider.json");
  });

  it("providers accepts a provider id shorthand for show", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".trailstep", "config.json"), {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: validManifest,
        },
      },
    });
    const lines: string[] = [];
    const command = resolveCommand(["providers", "my-agent", "--scope", "project"]);

    const exitCode = await command.run(
      command.parseArgs(["providers", "my-agent", "--scope", "project"]) as never,
      { cwd, io: { writeLine: (line) => lines.push(line), writeError: () => undefined } },
    );

    expect(exitCode).toBe(0);
    expect(lines).toContain("Id: my-agent");
    expect(lines).toContain("Source: local-manifest ./providers/my-agent.trailstep-provider.json");
  });

  it("show warns when a registered provider declares executable package hooks", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".trailstep", "config.json"), {
      providers: {
        "my-agent": {
          source: {
            type: "npm",
            packageName: "@example/provider",
            spec: "@example/provider",
            resolvedVersion: "1.2.3",
          },
          manifest: {
            ...validManifest,
            hooks: { beforeWorkingAgent: { supported: true } },
          },
        },
      },
    });
    const lines: string[] = [];
    const command = resolveCommand(["providers", "show", "my-agent", "--scope", "project"]);

    const exitCode = await command.run(
      command.parseArgs(["providers", "show", "my-agent", "--scope", "project"]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("executes provider package code");
  });

  it("remove reports the exact agent provider path and leaves config unchanged", async ({
    task,
  }) => {
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
        default: [{ provider: "my-agent" }],
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
    expect(errors.join("\n")).toContain("agents.default[0].provider");
    expect(await readJson(configPath)).toEqual(originalConfig);
  });

  it("remove reports the exact workflow agent provider path and leaves config unchanged", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    const originalConfig = {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: validManifest,
        },
      },
      workflows: {
        review: {
          agents: {
            reviewer: [{ provider: "my-agent" }],
          },
        },
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
    expect(errors.join("\n")).toContain("workflows.review.agents.reviewer[0].provider");
    expect(await readJson(configPath)).toEqual(originalConfig);
  });

  it("remove deletes only the unreferenced provider and preserves agent mappings", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await writeJson(configPath, {
      providers: {
        "my-agent": {
          source: { type: "local-manifest", path: "./providers/my-agent.trailstep-provider.json" },
          manifest: validManifest,
        },
        backup: {
          source: { type: "local-manifest", path: "./providers/backup.trailstep-provider.json" },
          manifest: { ...validManifest, id: "backup", displayName: "Backup" },
        },
      },
      agents: {
        default: [{ provider: "backup" }],
      },
    });
    const lines: string[] = [];
    const command = resolveCommand(["providers", "remove", "my-agent", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "remove", "my-agent", "--scope", "project"]) as never,
      { cwd, io: { writeLine: (line) => lines.push(line), writeError: () => undefined } },
    );

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("Removed provider my-agent");
    expect(await readJson(configPath)).toEqual({
      providers: {
        backup: {
          source: { type: "local-manifest", path: "./providers/backup.trailstep-provider.json" },
          manifest: { ...validManifest, id: "backup", displayName: "Backup" },
        },
      },
      agents: {
        default: [{ provider: "backup" }],
      },
    });
  });

  it("migrate rewrites legacy customProviders into providers without losing interactiveArgs or env", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await writeJson(configPath, {
      customProviders: {
        local: {
          binary: "local-agent",
          args: ["--json"],
          interactiveArgs: ["--tty", "--session", "{{sessionId}}"],
          cwd: "./agents/local",
          env: { API_KEY: "secret", FEATURE_FLAG: "on" },
          model: { supported: true, flag: "--model" },
          thinking: { supported: true, flag: "--thinking", levels: ["low", "high"] },
        },
      },
      agents: {
        default: [{ provider: "local", model: "fast", thinking: "high" }],
      },
    });
    const errors: string[] = [];
    const lines: string[] = [];
    const command = resolveCommand(["providers", "migrate", "--scope", "project"]);

    expect(command.name).toBe("providers");
    const exitCode = await command.run(
      command.parseArgs(["providers", "migrate", "--scope", "project"]) as never,
      {
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(lines.join("\n")).toContain("Migrated customProviders.local to providers.local");
    expect(await readJson(configPath)).toEqual({
      providers: {
        local: {
          source: { type: "legacy-custom-provider" },
          manifest: {
            schemaVersion: 1,
            id: "local",
            displayName: "local",
            working: {
              supported: true,
              command: "local-agent",
              args: ["--json"],
              prompt: { kind: "prompt-file" },
              output: { style: "provider-output-file" },
            },
            interactive: {
              supported: true,
              command: "local-agent",
              args: ["--tty", "--session", "{{sessionId}}"],
            },
            model: { supported: true, flag: "--model" },
            thinking: { supported: true, flag: "--thinking", levels: ["low", "high"] },
            cwd: "./agents/local",
            env: { API_KEY: "secret", FEATURE_FLAG: "on" },
          },
        },
      },
      agents: {
        default: [{ provider: "local", model: "fast", thinking: "high" }],
      },
    });
  });
});
