/**
 * `trst_list` tool: lists the available per-workflow TrailStep tools
 * (`{ name, description }`) from the same layered tool JSON load the server
 * uses for per-workflow tool listing. Exposed by the MCP server in list mode
 * (`mcp.perWorkflowTools: false`) so agents can discover workflow tools
 * without one tool per workflow in the tool list.
 */
import { type LoadPerWorkflowToolsOptions, loadPerWorkflowTools } from "./per_workflow.js";

export type TrstListOptions = LoadPerWorkflowToolsOptions;

export interface TrstListWorkflowEntry {
  readonly name: string;
  readonly description: string;
}

export interface TrstListResult {
  readonly workflows: readonly TrstListWorkflowEntry[];
}

export async function trstList(options: TrstListOptions = {}): Promise<TrstListResult> {
  return {
    workflows: loadPerWorkflowTools(options).map(({ name, description }) => ({
      name,
      description,
    })),
  };
}
