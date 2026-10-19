import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TrailStepCliIo, TrailStepCliPrompts } from "../command.types.js";
import {
  buildAddMcpSpawnRequest,
  formatAddMcpManualCommand,
  type McpRegistrationSpawnRequest,
  type McpRegistrationSpawnResult,
  offerMcpRegistration,
} from "./mcp-registration.js";

const SERVER_COMMAND = {
  command: "/abs/node",
  args: ["/abs/cli.js", "mcp", "--project", "/abs/project"],
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

  it("answers the scope question with global and prints the project-pinning note", async () => {
    const capture = captureRunner();
    const { lines, io } = recordingIo();
    const outcome = await offerMcpRegistration({
      projectDir,
      io,
      runner: capture.runner,
      prompts: promptsAnswering(["Global (user-level config)"], [true]),
      addMcpEntryPath: ADD_MCP_ENTRY,
      nodeBinaryPath: NODE_BINARY,
    });

    expect(outcome.status).toBe("registered");
    expect(outcome.scope).toBe("global");
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.args).toContain("--global");
    expect(
      lines.some((line) => line.includes("user-level config") && line.includes("--project")),
    ).toBe(true);
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
