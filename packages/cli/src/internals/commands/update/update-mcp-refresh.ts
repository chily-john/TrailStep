import type { CliCommandContext } from "../../command-framework/command.types.js";
import { refreshRegisteredWorkflowMcpTools } from "../../mcp-tools/registered-mcp-refresh.js";

/** Rewrites per-workflow MCP tool JSON for every registered workflow. */
export async function refreshRegisteredWorkflowMcpToolsAndReport(
  context: CliCommandContext,
): Promise<void> {
  const result = await refreshRegisteredWorkflowMcpTools({
    cwd: context.cwd,
    ...(context.homeDir === undefined ? {} : { homeDir: context.homeDir }),
  });
  for (const failure of result.failures) {
    context.io.writeError(
      `Warning: could not refresh MCP tool JSON for ${failure.registeredRef}: ${failure.message}`,
    );
  }
  if (result.generated.length > 0) {
    context.io.writeLine(
      `Refreshed MCP tool JSON for ${result.generated.length} registered workflow(s).`,
    );
  }
}
