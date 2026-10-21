import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { generateMcpToolJson } from "../../cli/src/internals/mcp-tools/mcp-tool-generation.js";
import { createServer } from "../src/server.js";

// Per-workflow MCP tools + list-mode config fallback contract:
// - generated `.trailstep/mcp/trst_<id>.json` files surface as `trst_<id>`
//   tools with params from the JSON `inputSchema`;
// - CallTool dispatches them through runWorkflowTool with the JSON's
//   `workflowRef` preset (args become the workflow input);
// - malformed JSONs and non-`trst_` names are skipped;
// - tool JSONs whose workflowRef no longer resolves (unregistered
//   `<namespace>/<name>`, missing direct workflow source) are skipped with a
//   stderr warning instead of publishing a dead tool;
// - `mcp.perWorkflowTools: false` lists `trst_list` instead of per-workflow
//   tools, and the default (config absent) is per-workflow tools.
//
// Layered artifacts are written only under per-test tmp directories (project
// and home layers are both tmp dirs; the repo and real home trees are never
// read or written).

interface Tmp {
  readonly root: string;
}

const tmpRoots: Tmp[] = [];
const clients: Client[] = [];

function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push({ root });
  return root;
}

function createTmpProject(): string {
  return tmpRoot("mcp-per-workflow-project-");
}

function createTmpHome(): string {
  return tmpRoot("mcp-per-workflow-home-");
}

async function connectedClient(projectDir: string): Promise<Client> {
  const server = createServer({ projectDir, homeDir: createTmpHome() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-per-workflow-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push(client);
  return client;
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.text ?? "";
}

function writeToolJson(projectDir: string, fileName: string, payload: unknown): void {
  const dir = path.join(projectDir, ".trailstep", "mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(payload), "utf8");
}

function validToolPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    name: "trst_demo",
    workflowRef: "flows/demo",
    description: "Demo per-workflow tool.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    source: { scope: "local", hash: "abc" },
    generatedBy: "trailstep",
    ...overrides,
  };
}

function writeProjectConfig(projectDir: string, fileName: string, config: unknown): void {
  const dir = path.join(projectDir, ".trailstep");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(config), "utf8");
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return predicate();
}

afterAll(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  while (tmpRoots.length > 0) {
    const tmp = tmpRoots.pop();
    if (tmp) {
      fs.rmSync(tmp.root, { recursive: true, force: true });
    }
  }
});

describe("per-workflow MCP tools", () => {
  it("e2e: generateMcpToolJson output is listed as a per-workflow tool with params", async () => {
    const projectDir = createTmpProject();
    await generateMcpToolJson(
      {
        id: "ship-it",
        description: "Ship a finished change set.",
        workflowRef: "flows/ship-it",
        sourceContent: "defineWorkflow({ id: 'ship-it' })",
        inputShape: { target: "string", dryRun: "boolean" },
      },
      { projectDir },
    );
    writeProjectConfig(projectDir, "config.json", {
      workflows: { flows: { "ship-it": "./flows/ship-it.mjs" } },
    });

    const client = await connectedClient(projectDir);
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "trst_ship-it");
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("Ship a finished change set.");

    const schema = tool?.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({
      target: { type: "string" },
      dryRun: { type: "boolean" },
    });
    expect([...(schema.required ?? [])].sort()).toEqual(["dryRun", "target"]);
  });

  it("defaults to per-workflow tools (no trst_list) when config is absent", async () => {
    const projectDir = createTmpProject();
    writeToolJson(projectDir, "trst_demo.json", validToolPayload());
    writeProjectConfig(projectDir, "config.json", {
      workflows: { flows: { demo: "./flows/demo.mjs" } },
    });

    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("trst_demo");
    expect(names).not.toContain("trst_list");
  });

  it("skips malformed tool JSONs with a warning and non-trst_ names silently", async () => {
    const projectDir = createTmpProject();
    const dir = path.join(projectDir, ".trailstep", "mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "trst_bad.json"), "{ not valid json", "utf8");
    writeToolJson(
      projectDir,
      "trst_broken.json",
      validToolPayload({ name: "trst_broken", description: undefined, inputSchema: undefined }),
    );
    writeToolJson(
      projectDir,
      "notes.json",
      validToolPayload({ name: "notes", workflowRef: "flows/notes" }),
    );
    writeToolJson(projectDir, "trst_ok.json", validToolPayload({ name: "trst_ok" }));
    writeProjectConfig(projectDir, "config.json", {
      workflows: { flows: { demo: "./flows/demo.mjs" } },
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("trst_ok");
    expect(names).not.toContain("trst_bad");
    expect(names).not.toContain("trst_broken");
    expect(names).not.toContain("notes");
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((part) => String(part).includes("trst_broken")),
      ),
    ).toBe(true);
    consoleError.mockRestore();
  });

  it("does not let a per-workflow JSON shadow a generic tool name", async () => {
    const projectDir = createTmpProject();
    writeToolJson(
      projectDir,
      "trst_watch.json",
      validToolPayload({
        name: "trst_watch",
        workflowRef: "flows/impostor",
        description: "Impostor tool.",
      }),
    );
    writeProjectConfig(projectDir, "config.json", {
      workflows: { flows: { impostor: "./flows/impostor.mjs" } },
    });

    const client = await connectedClient(projectDir);
    const listed = await client.listTools();
    const watch = listed.tools.filter((tool) => tool.name === "trst_watch");
    expect(watch).toHaveLength(1);
    expect(watch[0]?.description).toContain("Observe a TrailStep run");
  });

  it("dispatches a per-workflow tool through runWorkflowTool with the preset workflowRef", async () => {
    const projectDir = createTmpProject();
    writeToolJson(projectDir, "trst_demo.json", validToolPayload());
    writeProjectConfig(projectDir, "config.json", {
      workflows: { flows: { demo: "./flows/demo.mjs" } },
    });

    // Stub CLI entry: records the spawned argv instead of running a workflow,
    // then materializes the run directory so run_workflowTool's bounded
    // start-verification can confirm the run actually exists.
    const stubPath = path.join(projectDir, "stub-cli.mjs");
    const argvLogPath = path.join(projectDir, "spawned-argv.jsonl");
    fs.writeFileSync(
      stubPath,
      'import { appendFileSync, mkdirSync } from "node:fs";\n' +
        'import { join, resolve } from "node:path";\n' +
        'appendFileSync(process.env.MCP_TEST_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
        "const configuredRoot = process.env.TRAILSTEP_RUNS_ROOT;\n" +
        "const runsRoot = configuredRoot\n" +
        "  ? resolve(process.cwd(), configuredRoot)\n" +
        '  : join(process.cwd(), ".trailstep", "runs");\n' +
        "mkdirSync(join(runsRoot, process.argv[3]), { recursive: true });\n",
      "utf8",
    );

    const savedCliEntry = process.env.TRAILSTEP_CLI_ENTRY;
    const savedArgvLog = process.env.MCP_TEST_ARGV_LOG;
    process.env.TRAILSTEP_CLI_ENTRY = stubPath;
    process.env.MCP_TEST_ARGV_LOG = argvLogPath;
    try {
      const client = await connectedClient(projectDir);
      const call = await client.callTool({
        name: "trst_demo",
        arguments: { target: "prod" },
      });
      expect(call.isError).not.toBe(true);

      const payload = JSON.parse(firstText(call)) as {
        status?: string;
        workflow?: string;
        tool?: string;
        runId?: string;
      };
      expect(payload.status).toBe("started");
      expect(payload.workflow).toBe("flows/demo");
      expect(payload.tool).toBe("trst_demo");
      expect(typeof payload.runId).toBe("string");

      const appeared = await waitFor(() => fs.existsSync(argvLogPath), 10000);
      expect(appeared).toBe(true);
      const spawnedArgv = JSON.parse(
        fs.readFileSync(argvLogPath, "utf8").trim().split("\n")[0] ?? "[]",
      ) as string[];
      // Preset workflowRef cannot be redirected by call arguments.
      expect(spawnedArgv[0]).toBe("flows/demo");
      expect(spawnedArgv[2]).toBe("--input");
      expect(JSON.parse(spawnedArgv[3] ?? "{}")).toEqual({ target: "prod" });
    } finally {
      if (savedCliEntry === undefined) {
        delete process.env.TRAILSTEP_CLI_ENTRY;
      } else {
        process.env.TRAILSTEP_CLI_ENTRY = savedCliEntry;
      }
      if (savedArgvLog === undefined) {
        delete process.env.MCP_TEST_ARGV_LOG;
      } else {
        process.env.MCP_TEST_ARGV_LOG = savedArgvLog;
      }
    }
  });
});

describe("list mode (mcp.perWorkflowTools: false)", () => {
  it("lists trst_list instead of per-workflow tools and trst_list reports workflows", async () => {
    const projectDir = createTmpProject();
    writeProjectConfig(projectDir, "config.json", {
      version: 1,
      workflows: { flows: { demo: "./flows/demo.mjs" } },
      mcp: { perWorkflowTools: false },
    });
    writeToolJson(projectDir, "trst_demo.json", validToolPayload());

    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "trst_answer",
      "trst_list",
      "trst_resume",
      "trst_run_workflow",
      "trst_watch",
    ]);

    const call = await client.callTool({ name: "trst_list", arguments: {} });
    expect(call.isError).not.toBe(true);
    const payload = JSON.parse(firstText(call)) as {
      workflows: { name: string; description: string }[];
    };
    expect(payload.workflows).toEqual([
      { name: "trst_demo", description: "Demo per-workflow tool." },
    ]);
  });

  it("config-local.json overrides config.json for the mode flag", async () => {
    const projectDir = createTmpProject();
    writeProjectConfig(projectDir, "config.json", {
      version: 1,
      workflows: { flows: { demo: "./flows/demo.mjs" } },
      mcp: { perWorkflowTools: false },
    });
    writeProjectConfig(projectDir, "config-local.json", {
      mcp: { perWorkflowTools: true },
    });
    writeToolJson(projectDir, "trst_demo.json", validToolPayload());

    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("trst_demo");
    expect(names).not.toContain("trst_list");
  });

  it("a malformed config falls back to the per-workflow default", async () => {
    const projectDir = createTmpProject();
    const dir = path.join(projectDir, ".trailstep");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not valid json", "utf8");
    // A direct workflow source ref keeps the tool resolvable while the project
    // config layer is unreadable (so no registry entry can be written there).
    fs.writeFileSync(path.join(projectDir, "demo.mjs"), "export const demo = {};\n", "utf8");
    writeToolJson(projectDir, "trst_demo.json", validToolPayload({ workflowRef: "./demo.mjs" }));

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("trst_demo");
    expect(names).not.toContain("trst_list");
    consoleError.mockRestore();
  });
});

describe("stale workflowRef defense (load-time resolution check)", () => {
  it("skips only the tools whose workflowRef no longer resolves, with a stderr warning", async () => {
    const projectDir = createTmpProject();
    writeProjectConfig(projectDir, "config.json", {
      workflows: { flows: { kept: "./flows/kept.mjs" } },
    });
    // flows/demo is not registered in any config layer (e.g. left behind by a
    // remove); flows/kept is registered and must stay published.
    writeToolJson(projectDir, "trst_demo.json", validToolPayload());
    writeToolJson(
      projectDir,
      "trst_kept.json",
      validToolPayload({ name: "trst_kept", workflowRef: "flows/kept" }),
    );

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("trst_kept");
    expect(names).not.toContain("trst_demo");
    expect(
      consoleError.mock.calls.some((call) =>
        call.some(
          (part) =>
            String(part).includes("trst_demo") &&
            String(part).includes("flows/demo") &&
            String(part).includes("no longer resolves"),
        ),
      ),
    ).toBe(true);
    consoleError.mockRestore();
  });

  it("skips tools whose direct workflow source file no longer exists", async () => {
    const projectDir = createTmpProject();
    writeToolJson(
      projectDir,
      "trst_gone.json",
      validToolPayload({ name: "trst_gone", workflowRef: "./flows/gone.mjs" }),
    );

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("trst_gone");
    consoleError.mockRestore();
  });

  it("falls back to the default for an invalid mcp.perWorkflowTools value (core parseMcpConfig semantics)", async () => {
    const projectDir = createTmpProject();
    writeProjectConfig(projectDir, "config.json", {
      workflows: { flows: { demo: "./flows/demo.mjs" } },
      mcp: { perWorkflowTools: "yes" },
    });
    writeToolJson(projectDir, "trst_demo.json", validToolPayload());

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = await connectedClient(projectDir);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("trst_demo");
    expect(names).not.toContain("trst_list");
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((part) => String(part).includes("mcp.perWorkflowTools must be a boolean")),
      ),
    ).toBe(true);
    consoleError.mockRestore();
  });
});
