import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TrailStepCliIo, TrailStepCliPrompts } from "../command.types.js";
import {
  buildAddMcpSpawnRequest,
  buildTrailStepMcpServerCommand,
  defaultAddMcpEntryPath,
  formatAddMcpManualCommand,
  type McpRegistrationSpawnRequest,
  type McpRegistrationSpawnResult,
  offerMcpRegistration,
} from "./mcp-registration.js";

const SERVER_COMMAND = {
  command: "/abs/node",
  args: ["/abs/cli.js", "mcp", "--project", "/abs/project"],
} as const;

/** Global scope omits `--project` so the server follows the agent client's cwd. */
const GLOBAL_SERVER_COMMAND = {
  command: "/abs/node",
  args: ["/abs/cli.js", "mcp"],
} as const;

const ADD_MCP_ENTRY = "/abs/node_modules/add-mcp/bin.js";
const NODE_BINARY = "/abs/node";

function captureRunner(): {
  requests: McpRegistrationSpawnRequest[];
  respond: (result?: Partial<McpRegistrationSpawnResult>) => void;
  runner: (request: McpRegistrationSpawnRequest) => Promise<McpRegistrationSpawnResult>;
} {
  const requests: McpRegistrationSpawnRequest[] = [];
  let response: McpRegistrationSpawnResult = { exitCode: 0, stderr: "", stdout: "" };
  return {
    requests,
    respond: (result) => {
      response = { exitCode: 0, stderr: "", stdout: "", ...result };
    },
    runner: async (request) => {
      requests.push(request);
      return response;
    },
  };
}

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

function promptsAnswering(answers: string[], confirmResults: boolean[] = []): TrailStepCliPrompts {
  let selectIndex = 0;
  let confirmIndex = 0;
  return {
    text: async () => "",
    select: async (prompt: string, choices: readonly string[]) => {
      const answer = answers[selectIndex];
      selectIndex += 1;
      expect(choices, `unexpected select prompt: ${prompt}`).toContain(answer);
      return answer as string;
    },
    ...(confirmResults.length > 0
      ? {
          confirm: async () => {
            const answer = confirmResults[confirmIndex];
            confirmIndex += 1;
            return answer as boolean;
          },
        }
      : {}),
  };
}

describe("buildTrailStepMcpServerCommand scope shaping", () => {
  it("pins --project <absolute dir> for project scope (default)", () => {
    const command = buildTrailStepMcpServerCommand({
      projectDir: "/abs/project",
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: "/abs/cli.js",
    });
    expect(command.args).toEqual(["/abs/cli.js", "mcp", "--project", "/abs/project"]);
  });

  it("keeps the --project pin for local scope", () => {
    const command = buildTrailStepMcpServerCommand({
      projectDir: "/abs/project",
      scope: "local",
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: "/abs/cli.js",
    });
    expect(command.args).toEqual(["/abs/cli.js", "mcp", "--project", "/abs/project"]);
  });

  it("omits --project entirely for global scope (follow-me cwd)", () => {
    const command = buildTrailStepMcpServerCommand({
      projectDir: "/abs/project",
      scope: "global",
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: "/abs/cli.js",
    });
    expect(command.args).toEqual(["/abs/cli.js", "mcp"]);
    expect(command.args).not.toContain("--project");
  });
});

describe("buildAddMcpSpawnRequest scope argv mapping", () => {
  it("appends no scope flags for project scope (default)", () => {
    const request = buildAddMcpSpawnRequest({
      serverCommand: SERVER_COMMAND,
      projectDir: "/abs/project",
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });
    expect(request.args).not.toContain("--gitignore");
    expect(request.args).not.toContain("--global");
    expect(request.args).toContain("--name=trailstep");
    expect(request.args).not.toContain("--name=trailstep-global");
  });

  it("appends --gitignore for local scope", () => {
    const request = buildAddMcpSpawnRequest({
      serverCommand: SERVER_COMMAND,
      projectDir: "/abs/project",
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
      scope: "local",
    });
    expect(request.args).toContain("--gitignore");
    expect(request.args).not.toContain("--global");
  });

  it("appends --global for global scope", () => {
    const request = buildAddMcpSpawnRequest({
      serverCommand: SERVER_COMMAND,
      projectDir: "/abs/project",
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
      scope: "global",
    });
    expect(request.args).toContain("--global");
    expect(request.args).not.toContain("--gitignore");
  });

  it("uses the trailstep-global server name and forwards the omitted --project for global scope", () => {
    const request = buildAddMcpSpawnRequest({
      serverCommand: GLOBAL_SERVER_COMMAND,
      projectDir: "/abs/project",
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
      scope: "global",
    });
    expect(request.args).toContain("--name=trailstep-global");
    expect(request.args).toContain("--global");
    expect(request.args).not.toContain("--name=trailstep");
    expect(request.args).not.toContain("--args=--project");
    expect(request.args).toContain("--args=mcp");
  });

  it("keeps the trailstep name and --project forwarding for local scope", () => {
    const request = buildAddMcpSpawnRequest({
      serverCommand: SERVER_COMMAND,
      projectDir: "/abs/project",
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
      scope: "local",
    });
    expect(request.args).toContain("--name=trailstep");
    expect(request.args).not.toContain("--name=trailstep-global");
    expect(request.args).toContain("--args=--project");
  });
});

describe("formatAddMcpManualCommand scope flags", () => {
  it("renders a project-scope manual command without extra flags", () => {
    const command = formatAddMcpManualCommand({ serverCommand: SERVER_COMMAND, scope: "project" });
    expect(command.startsWith("npx add-mcp /abs/node")).toBe(true);
    expect(command).toContain("--name=trailstep");
    expect(command).not.toContain("--gitignore");
    expect(command).not.toContain("--global");
  });

  it("renders a local-scope manual command with --gitignore", () => {
    const command = formatAddMcpManualCommand({ serverCommand: SERVER_COMMAND, scope: "local" });
    expect(command.endsWith("--gitignore")).toBe(true);
    expect(command).not.toContain("--global");
  });

  it("renders a global-scope manual command with --global", () => {
    const command = formatAddMcpManualCommand({ serverCommand: SERVER_COMMAND, scope: "global" });
    expect(command.endsWith("--global")).toBe(true);
    expect(command).not.toContain("--gitignore");
    expect(command).toContain("--name=trailstep-global");
  });

  it("renders the global manual command with the omitted --project and trailstep-global name", () => {
    const command = formatAddMcpManualCommand({
      serverCommand: GLOBAL_SERVER_COMMAND,
      agentTargets: ["pi"],
      scope: "global",
    });
    expect(command).toContain("--name=trailstep-global");
    expect(command).toContain("--args=mcp");
    expect(command).not.toContain("--args=--project");
    expect(command).not.toContain("--name=trailstep ");
    expect(command.endsWith("--global")).toBe(true);
  });
});

describe("offerMcpRegistration headless", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-mcp-registration-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("defaults to project scope and prints the manual fallback without prompting", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      assumeYes: true,
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("manual");
    expect(outcome.scope).toBe("project");
    expect(capture.requests).toHaveLength(0);
    expect(outcome.manualCommand).not.toContain("--gitignore");
    expect(outcome.manualCommand).not.toContain("--global");
    expect(outcome.manualCommand).toContain("--name=trailstep");
    expect(outcome.serverCommand.args).toContain("--project");
    expect(lines).toContain(outcome.manualCommand);
  });

  it("prints the manual fallback for global scope without prompting or pinning --project", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      assumeYes: true,
      scope: "global",
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: "/abs/cli.js",
    });

    expect(outcome.status).toBe("manual");
    expect(outcome.scope).toBe("global");
    expect(capture.requests).toHaveLength(0);
    expect(outcome.manualCommand).toContain("--global");
    expect(outcome.manualCommand).toContain("--name=trailstep-global");
    expect(outcome.manualCommand).not.toContain("--args=--project");
    expect(outcome.serverCommand.args).toEqual(["/abs/cli.js", "mcp"]);
    expect(lines).toContain(outcome.manualCommand);
  });

  it("prints the manual fallback for local scope without spawning add-mcp", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      assumeYes: true,
      scope: "local",
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("manual");
    expect(outcome.scope).toBe("local");
    expect(capture.requests).toHaveLength(0);
    expect(outcome.manualCommand.endsWith("--gitignore")).toBe(true);
    expect(lines).toContain(outcome.manualCommand);
  });
});

describe("offerMcpRegistration prompt flow", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-mcp-registration-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("asks the scope question after the register confirm and spawns with project argv", async () => {
    const capture = captureRunner();
    const { io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Project (committed)"], [true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("registered");
    expect(outcome.scope).toBe("project");
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.args).not.toContain("--gitignore");
    expect(capture.requests[0]?.args).not.toContain("--global");
  });

  it("answers the scope question with local, previews the .gitignore append, and confirms", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Local (gitignored, stays on this machine)"], [true, true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("registered");
    expect(outcome.scope).toBe("local");
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.args).toContain("--gitignore");
    expect(lines.some((line) => line.includes(".gitignore"))).toBe(true);
  });

  it("declines local registration when the local confirm is rejected", async () => {
    const capture = captureRunner();
    const { io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Local (gitignored, stays on this machine)"], [true, false]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("declined");
    expect(outcome.scope).toBe("local");
    expect(capture.requests).toHaveLength(0);
    expect(outcome.manualCommand.endsWith("--gitignore")).toBe(true);
  });

  it("answers the scope question with global and prints the follow-me note", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Global (user-level config)"], [true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: "/abs/cli.js",
    });

    expect(outcome.status).toBe("registered");
    expect(outcome.scope).toBe("global");
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.args).toContain("--global");
    expect(outcome.manualCommand.endsWith("--global")).toBe(true);
    expect(capture.requests[0]?.args).toContain("--name=trailstep-global");
    expect(capture.requests[0]?.args).not.toContain("--args=--project");
    expect(
      lines.some(
        (line) => line.includes("user-level config") && line.includes("follows the agent client's"),
      ),
    ).toBe(true);
  });

  it("prints a scope-accurate manual command when add-mcp cannot be resolved", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Global (user-level config)"], [true]),
      addMcpEntryPath: null,
      nodeBinaryPath: NODE_BINARY,
      cliEntryPath: "/abs/cli.js",
    });

    expect(outcome.status).toBe("manual");
    expect(outcome.scope).toBe("global");
    expect(capture.requests).toHaveLength(0);
    expect(outcome.manualCommand).toContain("--global");
    expect(outcome.manualCommand).toContain("--name=trailstep-global");
    expect(outcome.manualCommand).not.toContain("--args=--project");
    expect(lines).toContain(outcome.manualCommand);
  });

  it("uses the explicitly provided scope without asking the WHERE question", async () => {
    const capture = captureRunner();
    const { io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      scope: "global",
      prompts: promptsAnswering([], [true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("registered");
    expect(outcome.scope).toBe("global");
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.args).toContain("--global");
  });

  it("shows that the .gitignore entry is already listed before confirming local", async () => {
    const gitignorePath = join(projectDir, ".gitignore");
    await writeFile(gitignorePath, "node_modules\n.mcp.json\n", "utf8");
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Local (gitignored, stays on this machine)"], [true, true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("registered");
    expect(lines.some((line) => line.includes("already listed"))).toBe(true);
    const gitignoreContent = await readFile(gitignorePath, "utf8");
    expect(gitignoreContent).toBe("node_modules\n.mcp.json\n");
  });
});

describe("offerMcpRegistration manual fallback re-render", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "trst-mcp-registration-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("re-renders the manual command with the resolved scope flags when add-mcp cannot be resolved", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Global (user-level config)"], [true]),
      resolveAddMcpEntry: () => undefined,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("manual");
    expect(outcome.scope).toBe("global");
    expect(capture.requests).toHaveLength(0);
    expect(outcome.manualCommand.endsWith("--global")).toBe(true);
    expect(outcome.manualCommand).not.toContain("--gitignore");
    expect(lines).toContain(outcome.manualCommand);
  });

  it("re-renders the manual command with the resolved scope flags when the spawn throws", async () => {
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: async () => {
        throw new Error("spawn blew up");
      },
      prompts: promptsAnswering(["Local (gitignored, stays on this machine)"], [true, true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.scope).toBe("local");
    expect(outcome.manualCommand.endsWith("--gitignore")).toBe(true);
    expect(lines).toContain(outcome.manualCommand);
  });

  it("re-renders the manual command with the resolved scope flags on ERR_TTY_INIT_FAILED", async () => {
    const capture = captureRunner();
    capture.respond({ exitCode: 1, stderr: "Error [ERR_TTY_INIT_FAILED]" });
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Local (gitignored, stays on this machine)"], [true, true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.scope).toBe("local");
    expect(capture.requests).toHaveLength(1);
    expect(outcome.manualCommand.endsWith("--gitignore")).toBe(true);
    expect(lines).toContain(outcome.manualCommand);
  });
});

describe("defaultAddMcpEntryPath resolution", () => {
  it("resolves the add-mcp bin entry through the @trailstep/mcp dependency chain", () => {
    const entry = defaultAddMcpEntryPath();
    expect(entry).toBeDefined();
    expect(entry?.replaceAll("\\", "/")).toContain("add-mcp");
  });

  it("keeps add-mcp as a production dependency of @trailstep/mcp so published installs can resolve it", async () => {
    const mcpPackageJsonPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "mcp",
      "package.json",
    );
    const parsed = JSON.parse(await readFile(mcpPackageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(parsed.dependencies?.["add-mcp"]).toBeDefined();
    expect(parsed.devDependencies?.["add-mcp"]).toBeUndefined();
  });
});
