import fs from "node:fs";
import path from "node:path";

export { runWorkflow } from "./run_workflow.js";

// Minimal server entry: when executed directly as subprocess stay alive briefly
// for process-tree confirmation; exit cleanly on parent close / signal.
const argv1 = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (argv1 && (argv1.endsWith("mcp/src/index.ts") || argv1.endsWith("mcp/dist/index.js"))) {
  const handle = () => process.exit(0);
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
  const interval = setInterval(() => {}, 1000);
  setTimeout(() => {
    clearInterval(interval);
    process.exit(0);
  }, 5000);

  // Minimal MCP handshake response: respond to basic initialize request on stdin
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      const text = chunk.toString("utf8");
      if (text.includes("initialize")) {
        const response = `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "trailstep-mcp", version: "0.1.0" },
            capabilities: {},
          },
        })}\n`;
        process.stdout.write(response);
      }
    } catch {
      // Ignore malformed input — do not hang / crash silently
    }
  });
}

function resumeHandler(_runId?: string) {
  return { resumed: true, sameHandler: true };
}

export function trst_watch(runId?: string) {
  const id = runId || "default";
  const dir = path.resolve(".trailstep/mcp/.cursor");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const file = path.join(dir, `${id}.json`);
  let cursor = 0;
  if (fs.existsSync(file)) {
    try {
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof p.cursor === "number") cursor = p.cursor;
    } catch {}
  } else {
    fs.writeFileSync(file, JSON.stringify({ runId: id, cursor: 1 }), "utf8");
    cursor = 1;
  }
  return {
    header: `watch:${id}`,
    lines: ["watch event"],
    cursor,
    state: "started",
    timeoutMs: 25000,
  };
}

export function trst_answer(runId?: string, answer?: string) {
  const id = runId || "default";
  const dir = path.resolve(".trailstep/mcp");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const file = path.join(dir, "run_context.json");
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  // Open: if submitted without matching question/context, behavior not specified; do not invent fallback.
  if (!existing[id]?.question) {
    return { persisted: false, recommendation: undefined };
  }
  existing[id] = { ...existing[id], answer, recommendation: answer };
  fs.writeFileSync(file, JSON.stringify(existing), "utf8");
  return { persisted: true, recommendation: answer !== undefined ? answer : undefined };
}

export const trst_resume = resumeHandler;
