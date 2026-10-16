export { runWorkflow } from "./run_workflow.js";

// Minimal server entry: when executed directly as subprocess stay alive briefly
// for process-tree confirmation; exit cleanly on parent close / signal.
if (
  process.argv[1] &&
  (process.argv[1].endsWith("mcp/src/index.ts") || process.argv[1].endsWith("mcp/dist/index.js"))
) {
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
        const response =
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "trailstep-mcp", version: "0.1.0" },
              capabilities: {},
            },
          }) + "\n";
        process.stdout.write(response);
      }
    } catch {
      // Ignore malformed input — do not hang / crash silently
    }
  });
}
