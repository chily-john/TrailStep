import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { main } from "./index.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const MAIN_TEST_ROOT = join("node_modules", ".tmp-trailstep-main-tests");

describe("main", () => {
  it("does not import the core provider registry from CLI source files", async () => {
    const sourceRoot = join(process.cwd(), "src");
    const files = await listSourceFiles(sourceRoot);
    const registryPattern = new RegExp(["provider", "Registry"].join(""));
    const registryKeyPattern = new RegExp(["Provider", "RegistryKey"].join(""));
    const providersPathPattern = new RegExp(["known-cli", "-providers"].join(""));

    await Promise.all(
      files.map(async (file) => {
        const contents = await readFile(file, "utf8");
        expect(contents, file).not.toMatch(registryPattern);
        expect(contents, file).not.toMatch(registryKeyPattern);
        expect(contents, file).not.toMatch(providersPathPattern);
      }),
    );
  });

  beforeAll(async () => {
    await rm(MAIN_TEST_ROOT, { recursive: true, force: true });
  });

  it("open creates a managed standalone session for the default configured agent", async ({
    task,
  }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-default`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { default: [{ provider: "claude" }] },
    });
    const lines: string[] = [];
    const errors: string[] = [];
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        runNameClock: () => new Date("2026-01-02T03:04:05.000Z"),
        runNameRandomSuffix: () => "abc123",
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
    const sessionRoot = join(cwd, ".trailstep", "sessions");
    const sessionDirs = await readdir(sessionRoot);
    expect(sessionDirs).toHaveLength(1);
    const [sessionDirName] = sessionDirs;
    if (sessionDirName === undefined) {
      throw new Error("Expected one session directory.");
    }
    const sessionDir = join(sessionRoot, sessionDirName);
    const sessionJson = JSON.parse(
      await readFile(join(sessionDir, "session.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(sessionJson).toMatchObject({
      id: "session-20260102-030405-abc123",
      requestedName: null,
      provider: "claude",
      launch: {
        backend: "built-in-provider",
        mode: "inherited-stdio",
        promptInjectionMode: "hidden-system-prompt-file",
      },
      status: "completed",
    });
    expect(sessionJson.resolvedTarget).toEqual({ provider: "claude" });
    const launchPrompt = await readFile(join(sessionDir, "launch-prompt.md"), "utf8");
    expect(launchPrompt).toContain("opened by TrailStep");
    expect(launchPrompt).toContain("dense session description");
    expect(requests[0]).toMatchObject({
      args: expect.arrayContaining([
        "--append-system-prompt-file",
        join(sessionDir, "launch-prompt.md"),
      ]),
    });
    expect(lines.join("\n")).toContain("Opened TrailStep agent session");
    expect(errors).toEqual([]);
  });

  it("open fails clearly when default agent is missing", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-missing-default`);
    const errors: string[] = [];
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open"],
        cwd,
        homeDir: join(cwd, "home"),
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(errors.join("\n")).toMatch(/no default agent/i);
    expect(errors.join("\n")).toMatch(/trailstep agents|trailstep init|configure/i);
  });

  it("open launches a named configured agent", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-named-agent`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { reviewer: [{ provider: "claude", model: "sonnet" }] },
    });
    const requests: unknown[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["open", "reviewer"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
    expect(requests[0]).toMatchObject({ args: expect.arrayContaining(["--model", "sonnet"]) });
    expect(errors).toEqual([]);
  });

  it("open launches a built-in provider ephemerally", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-builtin-provider`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open", "claude"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
  });

  it("open records hidden system prompt injection for claude", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-claude-prompt-mode`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open", "claude"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    const [sessionDirName] = await readdir(join(cwd, ".trailstep", "sessions"));
    const sessionJson = JSON.parse(
      await readFile(
        join(cwd, ".trailstep", "sessions", sessionDirName ?? "", "session.json"),
        "utf8",
      ),
    ) as Record<string, { promptInjectionMode?: string }>;
    expect(sessionJson.launch).toMatchObject({ promptInjectionMode: "hidden-system-prompt-file" });
    expect(requests[0]).toMatchObject({
      args: expect.arrayContaining([
        "--append-system-prompt-file",
        join(cwd, ".trailstep", "sessions", sessionDirName ?? "", "launch-prompt.md"),
      ]),
    });
  });

  it("open records hidden system prompt injection for pi", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-pi-prompt-mode`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open", "pi"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    const [sessionDirName] = await readdir(join(cwd, ".trailstep", "sessions"));
    const launchPromptPath = join(
      cwd,
      ".trailstep",
      "sessions",
      sessionDirName ?? "",
      "launch-prompt.md",
    );
    const sessionJson = JSON.parse(
      await readFile(
        join(cwd, ".trailstep", "sessions", sessionDirName ?? "", "session.json"),
        "utf8",
      ),
    ) as Record<string, { promptInjectionMode?: string }>;
    expect(sessionJson.launch).toMatchObject({ promptInjectionMode: "hidden-system-prompt-file" });
    expect(requests[0]).toMatchObject({
      command: "pi",
      args: ["--append-system-prompt", launchPromptPath],
    });
  });

  it("opens the default configured agent when argv is empty", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-default-agent`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { default: [{ provider: "claude" }] },
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: [],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
  });

  it("uses the first default target without prompting", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-default-first-target`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { default: [{ provider: "claude" }, { provider: "codex" }] },
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: [],
        cwd,
        prompts: undefined,
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
  });

  it("opens an unambiguous bare configured agent name", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-named-agent`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { reviewer: [{ provider: "claude", model: "sonnet" }] },
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["reviewer"],
        cwd,
        homeDir: join(cwd, "home"),
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
    expect(requests[0]).toMatchObject({ args: expect.arrayContaining(["--model", "sonnet"]) });
  });

  it("opens an unambiguous bare provider name", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-provider`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["claude"],
        cwd,
        homeDir: join(cwd, "home"),
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
    const sessionDirs = await readdir(join(cwd, ".trailstep", "sessions"));
    expect(sessionDirs).toHaveLength(1);
  });

  it("known subcommands still win over matching agent names", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-subcommand-before-agent`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { runs: [{ provider: "claude" }] },
    });
    const requests: unknown[] = [];
    const lines: string[] = [];

    await expect(
      main({
        argv: ["runs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toEqual([]);
    expect(lines.join("\n")).toContain("Active runs:");
  });

  it("the run subcommand wins over a matching agent name", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-run-subcommand-before-agent`);
    await writeJson(join(cwd, "package.json"), { name: "consumer" });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { run: [{ provider: "claude" }] },
    });
    const requests: unknown[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["run"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(errors.join("\n")).toMatch(/workflow/i);
  });

  it("direct workflow file refs still run workflows", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-direct-workflow`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "export const review = { id: 'review', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const lines: string[] = [];

    await expect(
      main({
        argv: ["./workflows/review.mjs"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toEqual([]);
    expect(lines.join("\n")).toContain("Workflow completed:");
    expect(lines.join("\n")).toContain("review.mjs");
  });

  it("registered namespaced workflow refs still run workflows", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-registered-workflow`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "export const review = { id: 'review', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const lines: string[] = [];

    await expect(
      main({
        argv: ["project/review"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toEqual([]);
    expect(lines.join("\n")).toContain("Workflow completed: project/review");
  });

  it("bare workflow-only registered name still runs the workflow", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-workflow-only-registered`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
      workflows: { project: { reviewer: "./workflows/reviewer.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "reviewer.mjs"),
      "export const reviewer = { id: 'reviewer', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const lines: string[] = [];

    await expect(
      main({
        argv: ["reviewer"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toEqual([]);
    expect(lines.join("\n")).toContain("Workflow completed: project/reviewer");
  });

  it("bare name that matches configured agent and workflow reports ambiguity", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-agent-workflow-ambiguous`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { reviewer: [{ provider: "claude" }] },
      workflows: { project: { reviewer: "./workflows/reviewer.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "reviewer.mjs"),
      "export const reviewer = { id: 'reviewer', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const errors: string[] = [];
    const requests: unknown[] = [];
    const events: unknown[] = [];

    await expect(
      main({
        argv: ["reviewer"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        eventSink: (event) => {
          events.push(event);
        },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(events).toEqual([]);
    expect(errors.join("\n")).toContain("Name is ambiguous: reviewer");
    expect(errors.join("\n")).toContain("trailstep open reviewer");
    expect(errors.join("\n")).toContain("project/reviewer");
  });

  it("bare name that matches provider and workflow reports ambiguity", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-provider-workflow-ambiguous`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
      workflows: { project: { claude: "./workflows/claude.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "claude.mjs"),
      "export const claude = { id: 'claude', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const errors: string[] = [];
    const requests: unknown[] = [];
    const events: unknown[] = [];

    await expect(
      main({
        argv: ["claude"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        eventSink: (event) => {
          events.push(event);
        },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(events).toEqual([]);
    expect(errors.join("\n")).toContain("Name is ambiguous: claude");
    expect(errors.join("\n")).toContain("trailstep open claude");
    expect(errors.join("\n")).toContain("project/claude");
  });

  it("bare name preserves workflow resolution errors instead of opening a matching agent", async ({
    task,
  }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-bare-agent-workflow-resolution-error`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { reviewer: [{ provider: "claude" }] },
      workflows: { project: { reviewer: "./workflows/ambiguous.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "ambiguous.mjs"),
      [
        "export const reviewer = { id: 'reviewer', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };",
        "export const second = { id: 'second', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };",
      ].join("\n"),
      "utf8",
    );
    const errors: string[] = [];
    const requests: unknown[] = [];
    const events: unknown[] = [];

    await expect(
      main({
        argv: ["reviewer"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        eventSink: (event) => {
          events.push(event);
        },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(events).toEqual([]);
    expect(errors.join("\n")).toContain("multiple workflow exports");
  });

  it("explicit open ignores a workflow with the same name and opens the agent", async ({
    task,
  }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-explicit-open-agent-not-workflow`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { reviewer: [{ provider: "claude" }] },
      workflows: { project: { reviewer: "./workflows/reviewer.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "reviewer.mjs"),
      "export const reviewer = { id: 'reviewer', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const events: unknown[] = [];

    await expect(
      main({
        argv: ["open", "reviewer"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        eventSink: (event) => {
          events.push(event);
        },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(events).toEqual([]);
    expect(requests[0]).toMatchObject({ command: "claude", cwd, shell: false, stdio: "inherit" });
  });

  it("open launches a custom provider with interactive args", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-custom-provider`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {
        local: {
          binary: "local-agent",
          interactiveArgs: ["--prompt-file", "{{promptFile}}"],
        },
      },
      agents: {},
    });
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open", "local"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "local-agent",
      args: ["--prompt-file", expect.stringContaining("launch-prompt.md")],
      cwd,
      shell: false,
      stdio: "inherit",
    });
    const [sessionDirName] = await readdir(join(cwd, ".trailstep", "sessions"));
    const sessionJson = JSON.parse(
      await readFile(
        join(cwd, ".trailstep", "sessions", sessionDirName ?? "", "session.json"),
        "utf8",
      ),
    ) as Record<string, { promptInjectionMode?: string }>;
    expect(sessionJson.launch).toMatchObject({ promptInjectionMode: "visible-prompt-file" });
  });

  it("open fails clearly for a custom provider without interactive args", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-custom-provider-not-interactive`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: {},
    });
    const errors: string[] = [];
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open", "local"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(errors.join("\n")).toMatch(/interactiveArgs/i);
    expect(errors.join("\n")).toMatch(/not openable|cannot run interactive|is not openable/i);
  });

  it("does not launch when session artifact creation fails", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-artifact-failure`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { default: [{ provider: "claude" }] },
    });
    await writeFile(join(cwd, ".trailstep", "sessions"), "not a directory", "utf8");
    const errors: string[] = [];
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["open"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(errors.join("\n")).toMatch(/session artifacts/i);
  });

  it("records failed status when provider runner throws after artifacts are created", async ({
    task,
  }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-runner-throws`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { default: [{ provider: "claude" }] },
    });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["open"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async () => {
          throw new Error("spawn claude ENOENT");
        },
      }),
    ).resolves.toBe(1);

    const [sessionDirName] = await readdir(join(cwd, ".trailstep", "sessions"));
    const sessionJson = JSON.parse(
      await readFile(
        join(cwd, ".trailstep", "sessions", sessionDirName ?? "", "session.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(sessionJson).toMatchObject({
      status: "failed",
      failure: {
        message:
          "Provider 'claude' could not be opened because the 'claude' CLI was not found on PATH. Install the CLI or configure a different TrailStep agent target.",
      },
    });
    expect(errors.join("\n")).toMatch(/claude.*not found on PATH/i);
  });

  it("records failed status and exit code when provider exits nonzero", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-runner-nonzero`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { default: [{ provider: "claude" }] },
    });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["open"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async () => ({ exitCode: 27 }),
      }),
    ).resolves.toBe(27);

    const [sessionDirName] = await readdir(join(cwd, ".trailstep", "sessions"));
    const sessionJson = JSON.parse(
      await readFile(
        join(cwd, ".trailstep", "sessions", sessionDirName ?? "", "session.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(sessionJson).toMatchObject({ status: "failed", exitCode: 27 });
    expect(errors.join("\n")).toMatch(/exited with code 27/i);
  });

  it("records completed status when provider exits zero", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-runner-zero`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { default: [{ provider: "claude" }] },
    });

    await expect(
      main({
        argv: ["open"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        agentSessionTerminalRunner: async () => ({ exitCode: 0 }),
        runNameClock: () => new Date("2026-01-02T03:04:05.000Z"),
      }),
    ).resolves.toBe(0);

    const [sessionDirName] = await readdir(join(cwd, ".trailstep", "sessions"));
    const sessionJson = JSON.parse(
      await readFile(
        join(cwd, ".trailstep", "sessions", sessionDirName ?? "", "session.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(sessionJson).toMatchObject({
      status: "completed",
      exitCode: 0,
      completedAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("does not call runner for providers that cannot be opened interactively", async ({ task }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-provider-not-interactive-no-runner`);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: {},
    });
    const requests: unknown[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["open", "local"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        agentSessionTerminalRunner: async (request) => {
          requests.push(request);
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(errors.join("\n")).toMatch(/not openable|cannot run interactive|interactiveArgs/i);
  });

  it("open workflow-only-name does not run the workflow and reports not openable", async ({
    task,
  }) => {
    const cwd = join(MAIN_TEST_ROOT, `${task.id}-open-workflow-only`);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: { "@acme/trailstep-workflows": "1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
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
      "export const workflowOnly = { id: 'workflowOnly', inputShape: {}, start: () => ({ kind: 'done', output: {} }) };",
      "utf8",
    );
    const errors: string[] = [];
    const events: unknown[] = [];

    await expect(
      main({
        argv: ["open", "workflowOnly"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        eventSink: (event) => {
          events.push(event);
        },
      }),
    ).resolves.toBe(1);

    expect(events).toEqual([]);
    expect(errors.join("\n")).toMatch(/no openable agent or provider/i);
  });
  it("prints discovered workflow ids for the workflows command", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", task.id);
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
    const errors: string[] = [];

    await expect(
      main({
        argv: ["workflows"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual([
      "No registered workflows to edit.",
      "@acme/trailstep-workflows:reviewFeature",
    ]);
    expect(errors).toEqual([]);
  });

  it("runs a discovered continuation workflow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-run`);
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
      "export const reviewFeature = { id: 'reviewFeature', inputShape: { ok: 'boolean' }, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];
    const events: unknown[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "run-001", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        eventSink: (event) => {
          events.push(event);
        },
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toContain(
      "Workflow completed: @acme/trailstep-workflows:reviewFeature",
    );
    expect(errors).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ payload: { input: { ok: true } } }));
  });

  it("run loads .trailstep/config.json and passes it to runWorkflow", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-config-run`);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: { "@acme/trailstep-workflows": "1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {
        local: { binary: "local-agent", args: ["{{promptFile}}", "{{outputFile}}"] },
      },
      agents: { small: [{ provider: "local", model: "fake-model" }] },
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
      [
        "import { done, step } from '@trailstep/core';",
        "export const reviewFeature = {",
        "  id: 'reviewFeature',",
        "  inputShape: { ok: 'boolean' },",
        "  outputShape: { answer: 'string' },",
        "  agents: { builder: { size: 'small' } },",
        "  start: () => step({ id: 'delegate' }).prompt('answer from configured agent', { output: { answer: 'string' }, agent: 'builder' }).do(done)({})",
        "};",
      ].join("\n"),
      "utf8",
    );
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "run-001", "--input", '{"ok":true}'],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        workingAgentProcessRunner: async (request) => {
          requests.push(request);
          await writeFile(request.outputFile, JSON.stringify({ answer: "from config" }), "utf8");
          return { exitCode: 0 };
        },
      }),
    ).resolves.toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "local-agent",
      args: [expect.stringContaining("prompt.md"), expect.stringContaining("output.json")],
      model: "fake-model",
      shell: false,
    });
  });

  it("run fails clearly when a configured working agent is needed but .trailstep/config.json is missing", async ({
    task,
  }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-main-tests",
      `${task.id}-missing-config-agent-run`,
    );
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
      [
        "import { done, step } from '@trailstep/core';",
        "export const reviewFeature = {",
        "  id: 'reviewFeature',",
        "  inputShape: { ok: 'boolean' },",
        "  outputShape: { answer: 'string' },",
        "  agents: { builder: { size: 'small' } },",
        "  start: () => step({ id: 'delegate' }).prompt('answer from configured agent', { output: { answer: 'string' }, agent: 'builder' }).do(done)({})",
        "};",
      ].join("\n"),
      "utf8",
    );
    const errors: string[] = [];
    const requests: unknown[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "run-001", "--input", '{"ok":true}'],
        cwd,
        homeDir: join(cwd, "home"),
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
        workingAgentProcessRunner: async (request) => {
          requests.push(request);
          throw new Error("working agent runner should not be called without config");
        },
      }),
    ).resolves.toBe(1);

    expect(requests).toEqual([]);
    expect(errors.join("\n")).toMatch(/missing \.trailstep\/config\.json/i);
    expect(errors.join("\n")).toMatch(/agent 'builder'/i);
  });

  it("malformed .trailstep/config.json reports a CLI input error", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-malformed-config`);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeFile(join(cwd, ".trailstep", "config.json"), "{", "utf8");
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "run-001", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/invalid \.trailstep\/config\.json/i);
  });

  it("invalid .trailstep/config.json schema reports a CLI input error", async ({ task }) => {
    const cwd = join(
      "node_modules",
      ".tmp-trailstep-main-tests",
      `${task.id}-invalid-config-schema`,
    );
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: { tiny: [{ provider: "missing-command" }] },
    });
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "run-001", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/invalid \.trailstep\/config\.json/i);
    expect(errors.join("\n")).toMatch(/missing-command/i);
  });

  it("workflows does not require .trailstep/config.json", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-list-without-config`);
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
    await writeFile(join(packageDir, "index.mjs"), "export {};", "utf8");
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["workflows"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(0);

    expect(lines).toEqual(["No registered workflows to edit."]);
    expect(errors).toEqual([]);
  });

  it("runs representative README-compatible workflow refs", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-readme-flows`);
    const packageDir = join(cwd, "node_modules", "@acme", "workflows");
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      name: "consumer",
      dependencies: { "@acme/workflows": "1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      version: 1,
      customProviders: {},
      agents: {},
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "export const review = { id: 'review', inputShape: { ok: 'boolean' }, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/workflows",
      version: "1.0.0",
      type: "module",
      main: "./index.mjs",
      trailstep: { workflows: { release: "./index.mjs#release" } },
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "export const release = { id: 'release', inputShape: { ok: 'boolean' }, start: (input) => ({ kind: 'done', output: input }) };",
      "utf8",
    );
    const errors: string[] = [];

    const run = async (argv: string[]) => {
      const lines: string[] = [];
      await expect(
        main({
          argv,
          cwd,
          io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
          runNameClock: () => new Date("2026-01-02T03:04:05.000Z"),
          runNameRandomSuffix: () => "abc123",
        }),
      ).resolves.toBe(0);
      return lines.join("\n");
    };

    await expect(
      run(["./workflows/review.mjs", "direct-run", "--input", '{"ok":true}']),
    ).resolves.toMatch(/Workflow completed: .*review\.mjs/);
    await expect(run(["./workflows/review.mjs", "--input", '{"ok":true}'])).resolves.toContain(
      join(".trailstep", "runs", "review-20260102-030405-abc123"),
    );
    await expect(
      run(["project/review", "project-run", "--input", '{"ok":true}']),
    ).resolves.toContain("Workflow completed: project/review");
    await expect(
      run(["@acme/workflows#release", "bundle-run", "--input", '{"ok":true}']),
    ).resolves.toContain("Workflow completed: @acme/workflows#release");
    expect(errors).toEqual([]);
  });

  it("prints clean errors for invalid JSON before a run starts", async () => {
    const errors: string[] = [];

    await expect(
      main({
        argv: ["@acme/trailstep-workflows:reviewFeature", "run-001", "--input", "{"],
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors.join("\n")).toMatch(/invalid JSON/i);
  });

  it("prints the full error.cause chain when a direct workflow file fails to import", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-direct-import-cause`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(
      join(cwd, "workflows", "broken.mjs"),
      "throw new Error('inner failure detail');\n",
      "utf8",
    );
    const errors: string[] = [];

    await expect(
      main({
        argv: ["./workflows/broken.mjs", "direct-run", "--input", "{}"],
        cwd,
        io: { writeLine: () => undefined, writeError: (line) => errors.push(line) },
      }),
    ).resolves.toBe(1);

    expect(errors).toContainEqual(
      expect.stringContaining("Unable to import direct workflow source"),
    );
    expect(errors).toContainEqual(expect.stringMatching(/^Caused by: .*inner failure detail/));
  });

  it("doctor reports a clean deprecation scan for registered workflow packages", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-doctor-clean`);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/authoring": "1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/trailstep-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/trailstep-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { defineWorkflow } from '@trailstep/authoring';\nexport const review = defineWorkflow;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedAuthoringSymbol],
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toMatch(/no TrailStep deprecation findings/i);
    expect(errors).toEqual([]);
  });

  it("doctor includes direct-file registered workflows in the deprecation scan", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-doctor-direct-file`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/authoring": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@trailstep", "authoring", "package.json"), {
      name: "@trailstep/authoring",
      version: "1.0.0",
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { removedStep } from '@trailstep/authoring';\nexport const review = removedStep;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedAuthoringSymbol],
      }),
    ).resolves.toBe(2);

    expect(lines.join("\n")).toContain("blocking @trailstep/authoring/removedStep");
    expect(lines.join("\n")).toContain("workflows/review.mjs");
    expect(errors).toEqual(["Doctor found blocking deprecation findings."]);
  });

  it("doctor reports warning deprecations without blocking", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-doctor-warning`);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/authoring": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@trailstep", "authoring", "package.json"), {
      name: "@trailstep/authoring",
      version: "1.0.0",
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/trailstep-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/trailstep-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { oldStep } from '@trailstep/authoring';\nexport const review = oldStep;\n",
      "utf8",
    );
    const lines: string[] = [];

    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        deprecationManifest: [
          { ...removedAuthoringSymbol, symbol: "oldStep", removedIn: undefined },
        ],
      }),
    ).resolves.toBe(1);

    expect(lines.join("\n")).toContain("warning @trailstep/authoring/oldStep");
  });

  it("doctor returns a blocking result for removed symbols", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-doctor-blocking`);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/authoring": "1.0.0" },
    });
    await writeJson(join(cwd, "node_modules", "@trailstep", "authoring", "package.json"), {
      name: "@trailstep/authoring",
      version: "1.0.0",
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/trailstep-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/trailstep-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep } from '@trailstep/authoring';\nexport const review = removedStep;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedAuthoringSymbol],
      }),
    ).resolves.toBe(2);

    expect(lines.join("\n")).toContain("blocking @trailstep/authoring/removedStep");
    expect(errors.join("\n")).toMatch(/blocking deprecation findings/i);
  });

  it("doctor does not detect aliased imports (known limitation)", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-doctor-aliased`);
    const packageDir = join(cwd, "node_modules", "@acme", "trailstep-workflows");
    await mkdir(packageDir, { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/authoring": "1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/trailstep-workflows" } },
    });
    await writeJson(join(packageDir, "package.json"), {
      name: "@acme/trailstep-workflows",
      version: "1.0.0",
      main: "index.mjs",
    });
    await writeFile(
      join(packageDir, "index.mjs"),
      "import { removedStep as rs } from '@trailstep/authoring';\nexport const review = rs;\n",
      "utf8",
    );
    const lines: string[] = [];
    const errors: string[] = [];

    // The scanner is text/regex-based, not a type-checker: once a symbol is imported under an
    // alias, its usage is under the new local name, and the scanner deliberately does not track
    // aliases through to their usage sites. Neither "removedStep" nor "rs" should match.
    await expect(
      main({
        argv: ["doctor"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: (line) => errors.push(line) },
        deprecationManifest: [removedAuthoringSymbol],
      }),
    ).resolves.toBe(0);

    expect(lines.join("\n")).toMatch(/no TrailStep deprecation findings/i);
    expect(errors).toEqual([]);
  });

  it("update workflows-only leaves TrailStep package entries unchanged", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-update-workflows`);
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    const packageJsonPath = join(cwd, "package.json");
    await writeJson(packageJsonPath, {
      dependencies: { "@trailstep/core": "^1.0.0", "@acme/workflows": "^1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "@acme/workflows#review" } },
    });

    await expect(
      main({
        argv: ["update", "--workflows", "--assume-yes"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify([{ version: "1.1.0" }]),
        }),
      }),
    ).resolves.toBe(0);

    expect(await readFile(packageJsonPath, "utf8")).toContain('"@trailstep/core": "^1.0.0"');
  });

  it("update --all prints direct-file skips and excludes that file from the deprecation scan", async ({
    task,
  }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-update-all-direct`);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "^1.0.0", "@trailstep/authoring": "^1.0.0" },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      workflows: { project: { review: "./workflows/review.mjs" } },
    });
    await writeFile(
      join(cwd, "workflows", "review.mjs"),
      "import { oldStep } from '@trailstep/authoring';\nexport const review = oldStep;\n",
      "utf8",
    );
    const lines: string[] = [];

    await expect(
      main({
        argv: ["update", "--all", "--assume-yes"],
        cwd,
        io: { writeLine: (line) => lines.push(line), writeError: () => undefined },
        packageCommandRunner: latestTrailStepTwo,
        deprecationManifest: [
          { ...removedAuthoringSymbol, symbol: "oldStep", removedIn: undefined },
        ],
      }),
    ).resolves.toBe(0);

    // Direct-file registrations still produce workflow-package update skip messages, but the
    // TrailStep self-update preflight scans their source because TrailStep API changes can affect
    // direct workflow files too.
    expect(lines.join("\n")).toContain("Skipped project/review: local file source");
    expect(lines.join("\n")).toContain("warning @trailstep/authoring/oldStep");
    expect(lines.join("\n")).toContain("workflows/review.mjs");
  });

  it("update self-update uses the detected package manager from main()", async ({ task }) => {
    const cwd = join("node_modules", ".tmp-trailstep-main-tests", `${task.id}-update-pm`);
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "yarn.lock"), "", "utf8");
    await writeJson(join(cwd, "package.json"), {
      dependencies: { "@trailstep/core": "^1.0.0" },
    });
    const installRequests: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

    await expect(
      main({
        argv: ["update", "--project", "--assume-yes"],
        cwd,
        io: { writeLine: () => undefined, writeError: () => undefined },
        packageCommandRunner: async (request) => {
          if (request.args[0] === "install") {
            installRequests.push(request);
            return { exitCode: 0 };
          }
          return latestTrailStepTwo(request);
        },
      }),
    ).resolves.toBe(0);

    expect(installRequests).toEqual([{ command: "yarn", args: ["install"], cwd }]);
  });
});

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listSourceFiles(entryPath);
      }
      return entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

const removedAuthoringSymbol = {
  packageName: "@trailstep/authoring",
  symbol: "removedStep",
  deprecatedSince: "0.5.0",
  removedIn: "1.0.0",
  message: "removedStep was removed.",
  replacement: "step",
};

async function latestTrailStepTwo(request: { readonly args: readonly string[] }) {
  const metadata: Record<string, unknown> = {
    "@trailstep/core": [{ version: "2.0.0" }],
    "@trailstep/authoring": [
      { version: "2.0.0", peerDependencies: { "@trailstep/core": "^2.0.0" } },
    ],
    "@trailstep/cli": [{ version: "2.0.0", peerDependencies: { "@trailstep/core": "^2.0.0" } }],
  };
  const packageName = String(request.args[1]).replace(/@\*$/u, "");
  return { exitCode: 0, stdout: JSON.stringify(metadata[packageName]) };
}
