import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TrailStepCliIo } from "../command-framework/command.types.js";
import {
  type McpRegistrationSpawnRequest,
  type McpRegistrationSpawnResult,
  mcpServerNameForScope,
  offerMcpRegistration,
} from "./mcp-registration.js";
import {
  buildPiMcpServerEntry,
  formatPiManualCommand,
  PI_MCP_SERVER_DESCRIPTION,
  resolvePiMcpConfigPath,
  writePiMcpServerEntry,
} from "./pi-mcp-registration.js";

const NODE_BINARY = "/abs/node";
const CLI_ENTRY = "/abs/cli.js";

function recordingIo(): { lines: string[]; io: TrailStepCliIo } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      writeLine: (line: string) => {
        lines.push(line);
      },
      writeError: (line: string) => {
        lines.push(line);
      },
    },
  };
}

function captureRunner(): {
  requests: McpRegistrationSpawnRequest[];
  runner: (request: McpRegistrationSpawnRequest) => Promise<McpRegistrationSpawnResult>;
} {
  const requests: McpRegistrationSpawnRequest[] = [];
  return {
    requests,
    runner: async (request) => {
      requests.push(request);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  };
}

describe("pi mcp registration", () => {
  let projectDir: string;
  let userAgentDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-pi-mcp-"));
    userAgentDir = await mkdtemp(join(tmpdir(), "trst-pi-mcp-user-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(userAgentDir, { recursive: true, force: true });
  });

  it("writes the full pi entry for project scope", async () => {
    const result = await writePiMcpServerEntry({
      projectDir,
      scope: "project",
      serverName: mcpServerNameForScope("project"),
      serverCommand: {
        command: NODE_BINARY,
        args: [CLI_ENTRY, "mcp", "--project", projectDir],
      },
      cliEntryPath: CLI_ENTRY,
    });

    expect(result.status).toBe("registered");
    const configPath = join(projectDir, ".pi", "mcp.json");
    expect(result.configPath).toBe(configPath);

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcpServers.trailstep).toEqual({
      command: NODE_BINARY,
      args: [CLI_ENTRY, "mcp", "--project", projectDir],
      env: { TRAILSTEP_CLI_ENTRY: CLI_ENTRY },
      exposure: "codemode",
      toolExposure: {
        trst_run_workflow: "direct",
        trst_watch: "direct",
        trst_answer: "direct",
        trst_resume: "direct",
      },
      description: PI_MCP_SERVER_DESCRIPTION,
    });
  });

  it("points at the instructions resource in the pi server description", () => {
    expect(PI_MCP_SERVER_DESCRIPTION).toContain("trailstep://instructions");
  });

  it("uses the same project path for local scope", async () => {
    const result = await writePiMcpServerEntry({
      projectDir,
      scope: "local",
      serverName: mcpServerNameForScope("local"),
      serverCommand: {
        command: NODE_BINARY,
        args: [CLI_ENTRY, "mcp", "--project", projectDir],
      },
      cliEntryPath: CLI_ENTRY,
    });

    expect(result.status).toBe("registered");
    expect(result.configPath).toBe(join(projectDir, ".pi", "mcp.json"));
    expect(result.configPath).toBe(resolvePiMcpConfigPath({ projectDir, scope: "project" }));
  });

  it("writes the user-level file for global scope without pinning --project", async () => {
    const result = await writePiMcpServerEntry({
      projectDir,
      scope: "global",
      serverName: mcpServerNameForScope("global"),
      serverCommand: { command: NODE_BINARY, args: [CLI_ENTRY, "mcp"] },
      cliEntryPath: CLI_ENTRY,
      env: { PI_CODING_AGENT_DIR: userAgentDir },
    });

    expect(result.status).toBe("registered");
    expect(result.configPath).toBe(join(userAgentDir, "mcp.json"));
    expect(result.serverName).toBe("trailstep-global");

    const parsed = JSON.parse(await readFile(result.configPath, "utf8")) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(parsed.mcpServers["trailstep-global"]?.args).toEqual([CLI_ENTRY, "mcp"]);
    expect(parsed.mcpServers["trailstep-global"]?.args).not.toContain("--project");
  });

  it("honors PI_CODING_AGENT_DIR for the user-level directory", async () => {
    const withOverride = resolvePiMcpConfigPath({
      projectDir,
      scope: "global",
      env: { PI_CODING_AGENT_DIR: userAgentDir },
    });
    expect(withOverride).toBe(join(userAgentDir, "mcp.json"));

    const withoutOverride = resolvePiMcpConfigPath({
      projectDir,
      scope: "global",
      env: {},
    });
    expect(withoutOverride).toBe(join(homedir(), ".pi", "agent", "mcp.json"));
  });

  it("preserves other servers and unknown top-level keys", async () => {
    const configPath = join(projectDir, ".pi", "mcp.json");
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          autoEnableCodemode: true,
          mcpServers: {
            other: { command: "other-bin", args: ["serve"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await writePiMcpServerEntry({
      projectDir,
      scope: "project",
      serverName: mcpServerNameForScope("project"),
      serverCommand: {
        command: NODE_BINARY,
        args: [CLI_ENTRY, "mcp", "--project", projectDir],
      },
      cliEntryPath: CLI_ENTRY,
    });

    expect(result.status).toBe("registered");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      autoEnableCodemode: boolean;
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.autoEnableCodemode).toBe(true);
    expect(parsed.mcpServers.other).toEqual({ command: "other-bin", args: ["serve"] });
    expect(parsed.mcpServers.trailstep?.exposure).toBe("codemode");
  });

  it("is idempotent: writing twice yields identical content", async () => {
    const request = {
      projectDir,
      scope: "project" as const,
      serverName: mcpServerNameForScope("project"),
      serverCommand: {
        command: NODE_BINARY,
        args: [CLI_ENTRY, "mcp", "--project", projectDir],
      },
      cliEntryPath: CLI_ENTRY,
    };

    expect((await writePiMcpServerEntry(request)).status).toBe("registered");
    const first = await readFile(join(projectDir, ".pi", "mcp.json"), "utf8");
    expect((await writePiMcpServerEntry(request)).status).toBe("registered");
    const second = await readFile(join(projectDir, ".pi", "mcp.json"), "utf8");

    expect(second).toBe(first);
  });

  it("does not clobber an existing entry with a different command and reports it", async () => {
    const configPath = join(projectDir, ".pi", "mcp.json");
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          trailstep: { command: "/other/node", args: ["/other/cli.js", "mcp"] },
        },
      }),
      "utf8",
    );

    const result = await writePiMcpServerEntry({
      projectDir,
      scope: "project",
      serverName: mcpServerNameForScope("project"),
      serverCommand: {
        command: NODE_BINARY,
        args: [CLI_ENTRY, "mcp", "--project", projectDir],
      },
      cliEntryPath: CLI_ENTRY,
    });

    expect(result.status).toBe("existing");
    expect(result.reason).toContain("differently-configured");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.mcpServers.trailstep?.command).toBe("/other/node");
  });

  it("reports malformed JSON instead of throwing", async () => {
    const configPath = join(projectDir, ".pi", "mcp.json");
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(configPath, "{ not json", "utf8");

    const result = await writePiMcpServerEntry({
      projectDir,
      scope: "project",
      serverName: mcpServerNameForScope("project"),
      serverCommand: {
        command: NODE_BINARY,
        args: [CLI_ENTRY, "mcp", "--project", projectDir],
      },
      cliEntryPath: CLI_ENTRY,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("malformed JSON");
    expect(await readFile(configPath, "utf8")).toBe("{ not json");
  });
});

describe("pi mcp entry helpers", () => {
  it("omits env when the CLI entry path is unknown", () => {
    const entry = buildPiMcpServerEntry({
      serverCommand: { command: "trailstep", args: ["mcp"] },
    });
    expect(entry.env).toBeUndefined();
    expect(entry.exposure).toBe("codemode");
    expect(entry.toolExposure.trst_run_workflow).toBe("direct");
  });

  it("renders the pi-native manual command", () => {
    const command = formatPiManualCommand({
      serverCommand: {
        command: NODE_BINARY,
        args: [CLI_ENTRY, "mcp", "--project", "/abs/project"],
      },
      serverName: "trailstep",
    });
    expect(command).toBe(
      `pi mcp add trailstep -- ${NODE_BINARY} ${CLI_ENTRY} mcp --project /abs/project`,
    );
    expect(command).not.toContain("add-mcp");
  });
});

describe("offerMcpRegistration with pi detected", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-pi-mcp-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("excludes pi from the add-mcp -a list and forwards the other detected agents", async () => {
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await mkdir(join(projectDir, ".claude"), { recursive: true });

    const capture = captureRunner();
    const { io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      scope: "project",
      prompts: { text: async () => "", select: async () => "", confirm: async () => true },
      addMcpEntryPath: "/abs/node_modules/add-mcp/bin.js",
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: CLI_ENTRY,
    });

    expect(outcome.status).toBe("registered");
    expect(outcome.agentTargets).toContain("pi");
    expect(capture.requests).toHaveLength(1);
    const args = capture.requests[0]?.args ?? [];
    expect(args).toContain("-a");
    expect(args).toContain("claude-code");
    expect(args).not.toContain("pi");
  });

  it("does not spawn add-mcp at all when pi is the only detected target", async () => {
    await mkdir(join(projectDir, ".pi"), { recursive: true });

    const capture = captureRunner();
    const { io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      scope: "project",
      prompts: { text: async () => "", select: async () => "", confirm: async () => true },
      addMcpEntryPath: "/abs/node_modules/add-mcp/bin.js",
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: CLI_ENTRY,
    });

    expect(outcome.status).toBe("registered");
    expect(capture.requests).toHaveLength(0);
    expect(outcome.manualCommand).toContain("pi mcp add trailstep");
    const parsed = JSON.parse(await readFile(join(projectDir, ".pi", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcpServers.trailstep?.exposure).toBe("codemode");
  });

  it("still reports registered when the pi write fails", async () => {
    // A file named `.pi` blocks the `.pi` directory creation, so the pi
    // config write fails while pi is still detected as a target.
    await writeFile(join(projectDir, ".pi"), "not a directory", "utf8");

    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      scope: "project",
      prompts: { text: async () => "", select: async () => "", confirm: async () => true },
      addMcpEntryPath: "/abs/node_modules/add-mcp/bin.js",
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: CLI_ENTRY,
    });

    expect(outcome.status).toBe("registered");
    expect(lines.some((line) => line.includes("Warning:"))).toBe(true);
    expect(lines.some((line) => line.includes("pi mcp add trailstep"))).toBe(true);
  });
});
