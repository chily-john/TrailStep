/**
 * Legacy module path for the `run_workflow` tool.
 * Re-exports the real thin adapter from `./tools/run_workflow.js` so existing
 * imports keep working; the fake `Date.now` run id is gone — run ids come from
 * the real generate-run-name scheme.
 */
export {
  type RunWorkflowResult,
  type RunWorkflowToolOptions,
  type RunWorkflowToolResult,
  runWorkflow,
  runWorkflowTool,
} from "./tools/index.js";
