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
}
