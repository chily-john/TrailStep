import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer, INSTRUCTIONS_RESOURCE_URI, PROJECT_RESOURCE_URI } from "../src/server.js";

// Contract test for the MCP server surface: tool registry wiring, CallTool
// dispatch to the real tool implementations, and the project/instructions
// resources. Uses a real MCP `Client` over the SDK's linked in-memory
// transport (same client API as StdioClientTransport, no process spawn).

interface TmpProject {
  readonly root: string;
}

const tmpProjects: TmpProject[] = [];
const clients: Client[] = [];

function createTmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-contract-"));
  tmpProjects.push({ root });
  return root;
}

async function connectedClient(projectDir: string): Promise<Client> {
  // Empty tmp home dir keeps the global config/tool JSON layer isolated from
  // the developer's real ~/.trailstep tree.
  const server = createServer({ projectDir, homeDir: createTmpProject() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-contract-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.text ?? "";
}

beforeAll(() => {
  // Keep accidental tool side effects out of the repo's own .trailstep tree.
});

afterAll(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  while (tmpProjects.length > 0) {
    const project = tmpProjects.pop();
    if (project) {
      fs.rmSync(project.root, { recursive: true, force: true });
    }
  }
});

describe("MCP server contract", () => {
  it("lists all four tools with object input schemas and required fields", async () => {
    const client = await connectedClient(createTmpProject());
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["trst_answer", "trst_resume", "trst_run_workflow", "trst_watch"]);

    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const required = Object.fromEntries(
      listed.tools.map((tool) => [tool.name, tool.inputSchema.required ?? []]),
    );
    expect(required.trst_run_workflow).toContain("workflow");
    expect(required.trst_watch).toContain("runId");
    expect(required.trst_answer).toEqual(expect.arrayContaining(["runId", "waitId", "answer"]));
    expect(required.trst_resume).toContain("runId");
  });

  it("trst_run_workflow rejects a missing workflow without spawning", async () => {
    const client = await connectedClient(createTmpProject());
    const call = await client.callTool({ name: "trst_run_workflow", arguments: {} });
    expect(call.isError).toBe(true);
    expect(firstText(call)).toContain("workflow");
  });

  it("trst_answer dispatches to the real adapter and reports unresolved waits", async () => {
    const client = await connectedClient(createTmpProject());
    const call = await client.callTool({
      name: "trst_answer",
      arguments: { runId: "no-such-run", waitId: "wait-1", answer: { decision: "yes" } },
    });
    expect(call.isError).not.toBe(true);
    const payload = JSON.parse(firstText(call)) as { persisted?: unknown; error?: unknown };
    expect(payload.persisted).toBe(false);
    expect(typeof payload.error).toBe("string");
  });

  it("trst_resume dispatches to the real adapter and reports unresolved runs", async () => {
    const client = await connectedClient(createTmpProject());
    const call = await client.callTool({
      name: "trst_resume",
      arguments: { runId: "no-such-run" },
    });
    expect(call.isError).not.toBe(true);
    const payload = JSON.parse(firstText(call)) as { resumed?: unknown; error?: unknown };
    expect(payload.resumed).toBe(false);
    expect(typeof payload.error).toBe("string");
  });

  it("trst_watch surfaces a missing run as an isError tool result", async () => {
    const client = await connectedClient(createTmpProject());
    const call = await client.callTool({
      name: "trst_watch",
      arguments: { runId: "no-such-run", verbosity: "brief" },
    });
    expect(call.isError).toBe(true);
    expect(firstText(call)).toContain("trst_watch");
  });

  it("rejects unknown tools as isError results, not silent hangs", async () => {
    const client = await connectedClient(createTmpProject());
    const call = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(call.isError).toBe(true);
    expect(firstText(call)).toContain("Unknown tool");
  });

  it("trailstep://project resource reports the resolved project directory", async () => {
    const projectDir = createTmpProject();
    const client = await connectedClient(projectDir);
    const resource = await client.readResource({ uri: PROJECT_RESOURCE_URI });
    const text = resource.contents[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ projectDir });
  });

  it("trailstep://instructions resource serves the generic + static snippet", async () => {
    const client = await connectedClient(createTmpProject());
    const resource = await client.readResource({ uri: INSTRUCTIONS_RESOURCE_URI });
    const text = resource.contents[0]?.text ?? "";
    expect(text).toContain("generic");
    expect(text).toContain('"watch": "trst_watch"');
    expect(text).toContain('"answer": "trst_answer"');
    expect(text).toContain('"resume": "trst_resume"');
  });

  it("trailstep://instructions serves the project's instructions.md when present", async () => {
    const projectDir = createTmpProject();
    const instructionsPath = path.join(projectDir, ".trailstep", "mcp", "instructions.md");
    fs.mkdirSync(path.dirname(instructionsPath), { recursive: true });
    fs.writeFileSync(instructionsPath, "# Project instructions marker\n", "utf8");

    const client = await connectedClient(projectDir);
    const resource = await client.readResource({ uri: INSTRUCTIONS_RESOURCE_URI });
    expect(resource.contents[0]?.text).toContain("Project instructions marker");
  });

  it("lists both project and instructions resources", async () => {
    const client = await connectedClient(createTmpProject());
    const listed = await client.listResources();
    const uris = listed.resources.map((resource) => resource.uri).sort();
    expect(uris).toEqual([PROJECT_RESOURCE_URI, INSTRUCTIONS_RESOURCE_URI].sort());
  });

  it("repo .trailstep/mcp/instructions.md carries generic + static snippet with no broken embeds", () => {
    const instructionsPath = path.resolve(".trailstep/mcp/instructions.md");
    expect(fs.existsSync(instructionsPath)).toBe(true);
    const content = fs.readFileSync(instructionsPath, "utf8");
    expect(content).toContain("Embedded generic snippet");
    expect(content).toContain("Embedded static snippet");
    expect(content).toContain('"watch": "trst_watch"');
    expect(content).toContain('"answer": "trst_answer"');
    expect(content).toContain('"resume": "trst_resume"');
    expect(content).not.toContain("embed failed");
  });
});
