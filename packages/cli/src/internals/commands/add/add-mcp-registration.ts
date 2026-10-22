import type { CliCommandContext } from "../../command-framework/command.types.js";
import {
  generateMcpToolJson,
  mcpToolInputFromWorkflow,
} from "../../mcp-tools/mcp-tool-generation.js";

import type { AddRegistration } from "./add-command.types.js";

/**
 * Regenerates `.trailstep/mcp/trst_<id>.json` for one successful `add`
 * registration. The registration itself already succeeded; generation problems
 * are reported as warnings and never fail the add.
 */
export async function generateMcpToolJsonForRegistration(
  namespace: string,
  registration: AddRegistration,
  projectDir: string,
  context: CliCommandContext,
): Promise<void> {
  const workflowRef = `${namespace}/${registration.name}`;
  const workflow = registration.registryTarget.workflow;
  if (workflow === undefined) {
    context.io.writeError(
      `Warning: skipped MCP tool JSON for ${workflowRef}: workflow definition could not be loaded.`,
    );
    return;
  }
  try {
    await generateMcpToolJson(mcpToolInputFromWorkflow(workflow, workflowRef), { projectDir });
    context.io.writeLine(`Generated MCP tool JSON for ${workflowRef}.`);
  } catch (error) {
    context.io.writeError(
      `Warning: could not generate MCP tool JSON for ${workflowRef}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}
