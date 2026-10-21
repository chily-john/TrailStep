import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

// Verification: `trailstep mcp --project <dir>` runs the MCP server in the CLI
// process itself (foreground stdio), stays alive across requests, completes the
// MCP handshake, and surfaces tool errors as MCP error results.

const cliEntry = pathToFileURL(join(import.meta.dirname, "..", "..", "..", "index.ts")).href;
const tmpRoot = join("node_modules", ".tmp-trailstep-mcp-tests");

// The CLI bin auto-run guard fires only for the built index.js entry, so the
// test drives main() through a tiny wrapper module (run via tsx) that mimics
// `trailstep mcp --project <dir>`.
async function writeMcpEntry(projectDir: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  const entryPath = join(
    tmpRoot,
    `mcp-entry-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  await writeFile(
    entryPath,
    `import { main } from ${JSON.stringify(cliEntry)};\n` +
      `process.exitCode = await main({ argv: ["mcp", "--project", ${JSON.stringify(projectDir)}] });\n`,
  );
  return entryPath;
}

// The CLI bin auto-run guard fires only for the built index.js entry, so the
// test drives main() through a tiny wrapper module (run via tsx) that mimics
// `trailstep mcp --project <dir>`.
//
// TRAILSTEP_CLI_ENTRY points the server's run_workflow spawn at a stub CLI
// entry that materializes the run directory: the real entry cannot start a
// `demo` workflow, and without a materialized run the tool reports
// status "failed" (isError) instead of "started" — see
// packages/mcp/src/tools/run_workflow.ts start verification. The stub makes
// the dispatch assertion deterministic on every platform (win32 refuses the
// PATH fallback outright).
async function writeStubCliEntry(): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  const stubPath = resolve(
    tmpRoot,
    `stub-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  await writeFile(
    stubPath,
    'import { mkdirSync } from "node:fs";\n' +
      'import { join } from "node:path";\n' +
      'const runsRoot = join(process.cwd(), ".trailstep", "runs");\n' +
      "mkdirSync(join(runsRoot, process.argv[3]), { recursive: true });\n",
  );
  return stubPath;
}

async function spawnMcpClient(projectDir: string): Promise<Client> {
  const entryPath = await writeMcpEntry(projectDir);
  const stubCliEntry = await writeStubCliEntry();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", entryPath],
    env: { TRAILSTEP_CLI_ENTRY: stubCliEntry },
  });
  const client = new Client({ name: "trailstep-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

afterAll(async () => {
  // Windows holds the spawned stdio server handles briefly after client.close();
  // delay + retry so cleanup does not EBUSY on rmdir.
  await sleep(250);
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("mcp command (foreground stdio server)", () => {
  it("completes handshake, stays alive, and serves tools", async () => {
    const projectDir = join(tmpRoot, "handshake");
    await mkdir(projectDir, { recursive: true });

    // Handshake (initialize) must succeed via the real MCP client.
    const client = await spawnMcpClient(projectDir);
    try {
      // Server stays alive across sequential round-trips (no quick exit).
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      await sleep(200);
      const toolsStillAlive = await client.listTools();
      expect(toolNames).toEqual(toolsStillAlive.tools.map((tool) => tool.name));
      for (const expected of ["trst_run_workflow"]) {
        expect(toolNames).toContain(expected);
      }

      // Tool dispatch works end-to-end and returns structured results.
      const call = await client.callTool({
        name: "trst_run_workflow",
        arguments: { workflow: "demo" },
      });
      expect(call.isError).not.toBe(true);
      const payload = JSON.parse(
        (call.content as readonly { type: string; text: string }[])[0]?.text ?? "{}",
      ) as { runId?: unknown; status?: unknown; workflow?: unknown };
      expect(typeof payload.runId).toBe("string");
      expect(payload.status).toBe("started");
      expect(payload.workflow).toBe("demo");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("surfaces unknown-tool failures as MCP error results, not silent hangs", async () => {
    const projectDir = join(tmpRoot, "tool-error");
    await mkdir(projectDir, { recursive: true });

    const client = await spawnMcpClient(projectDir);
    try {
      const call = await client.callTool({ name: "no_such_tool", arguments: {} });
      expect(call.isError).toBe(true);
      const text = (call.content as readonly { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("Unknown tool");
    } finally {
      await client.close();
    }
  }, 30_000);
});
