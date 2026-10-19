import type { Workflow } from "@trailstep/core";

import { listRegisteredWorkflowEntries } from "../workflow-registry/workflow-registry.js";
import { resolveWorkflowReference } from "../workflow-resolution/workflow-resolution.js";
import { generateMcpToolJson, mcpToolInputFromWorkflow } from "./mcp-tool-generation.js";

/**
 * Regenerates `.trailstep/mcp/trst_<id>.json` for every registered workflow.
 *
 * Called from the `trailstep update --workflows` flow (and `trailstep update`
 * overall) only; files are rewritten unconditionally. Resolution failures are
 * reported per registration and never abort the refresh of the other entries.
 */

export interface RegisteredMcpToolRefreshOptions {
  readonly cwd: string;
  readonly homeDir?: string;
}

export interface RegisteredMcpToolRefreshFailure {
  readonly registeredRef: string;
  readonly message: string;
}

export interface RegisteredMcpToolRefreshResult {
  /** Absolute paths of the rewritten tool JSON files. */
  readonly generated: readonly string[];
  readonly failures: readonly RegisteredMcpToolRefreshFailure[];
}

export async function refreshRegisteredWorkflowMcpTools(
  options: RegisteredMcpToolRefreshOptions,
): Promise<RegisteredMcpToolRefreshResult> {
  const entries = await listRegisteredWorkflowEntries({
    cwd: options.cwd,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });

  const generated: string[] = [];
  const failures: RegisteredMcpToolRefreshFailure[] = [];

  for (const entry of entries) {
    const registeredRef = `${entry.namespace}/${entry.name}`;
    try {
      const resolved = await resolveWorkflowReference(registeredRef, {
        cwd: options.cwd,
        ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      });
      const workflow = resolved?.workflow as Workflow | undefined;
      if (workflow === undefined) {
        failures.push({
          registeredRef,
          message: "workflow definition could not be resolved",
        });
        continue;
      }
      generated.push(
        await generateMcpToolJson(mcpToolInputFromWorkflow(workflow, registeredRef), {
          projectDir: options.cwd,
        }),
      );
    } catch (error) {
      failures.push({
        registeredRef,
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  return { generated, failures };
}
