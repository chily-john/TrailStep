import type {
  AgentExecutionConfig,
  ResolvedAgentExecutionConfig,
} from "../../contracts/agents/agent-execution.types.js";
import {
  collectAgentExecutionDiagnostics,
  resolveAgentExecutionConfig,
} from "../../contracts/agents/agent-execution.types.js";
import { TrailStepFailureError } from "../../contracts/failures/failure.js";

/**
 * A config-sourced execution block plus the config path it came from.
 *
 * Config blocks are read from JSON, so their shape is not checked by
 * TypeScript: the path is used to report an invalid block as a user error
 * (e.g. `settings.execution.contextFiles must be a boolean ...`).
 */
export interface ExecutionPolicyConfigSource {
  /** Config path of the block, used in failure diagnostics. */
  readonly path: string;
  /** The raw block as it was read from the config (undefined when absent). */
  readonly block: unknown;
}

export interface ResolveExecutionPolicyOptions {
  /**
   * The agent role's own execution block (the workflow author's choice, e.g.
   * the delegate's lean block). Lowest precedence: config blocks override it
   * field by field.
   */
  readonly role?: AgentExecutionConfig;
  /** The step-level execution block. Highest precedence. */
  readonly step?: AgentExecutionConfig;
  /** Global config block (`settings.execution`). */
  readonly global?: ExecutionPolicyConfigSource;
  /** Per-workflow config block (`workflows.<id>.settings.execution`). */
  readonly workflow?: ExecutionPolicyConfigSource;
}

const EXECUTION_FIELDS = [
  "tools",
  "skills",
  "mcp",
  "extensions",
  "contextFiles",
] as const satisfies readonly (keyof AgentExecutionConfig)[];

/**
 * Resolves the effective execution block for one agent step.
 *
 * Precedence, per field: step > workflow config > global config > role. The
 * merge is field-level, so a config block that names only `contextFiles`
 * changes only that field and leaves the role's other fields alone. A field
 * that is `undefined` in a higher-precedence source inherits the lower one,
 * while an explicit `false` / `[]` / `"project-only"` overrides it.
 *
 * Returns `undefined` when no block exists anywhere, which means "render no
 * hygiene args at all" (today's behavior for every agent without an execution
 * block). Config blocks are validated on their own so an invalid block is
 * reported against its config path instead of being silently ignored, and the
 * merged block is validated with the existing `resolveAgentExecutionConfig`
 * semantics so invalid role/step blocks still fail fast.
 */
export function resolveExecutionPolicy(
  options: ResolveExecutionPolicyOptions,
): ResolvedAgentExecutionConfig | undefined {
  const global = validatedConfigBlock(options.global);
  const workflow = validatedConfigBlock(options.workflow);

  const merged = mergeExecutionBlocks([options.role, global?.block, workflow?.block, options.step]);

  return merged === undefined ? undefined : resolveAgentExecutionConfig(merged);
}

/**
 * Validates a config-sourced block on its own and reports an invalid one as a
 * user error naming the config path, instead of letting it fail later as an
 * opaque provider error.
 */
function validatedConfigBlock(
  source: ExecutionPolicyConfigSource | undefined,
): { readonly block: AgentExecutionConfig } | undefined {
  if (source === undefined || source.block === undefined) {
    return undefined;
  }

  const diagnostics = collectAgentExecutionDiagnostics(source.block, source.path);
  if (diagnostics.length > 0) {
    throw new TrailStepFailureError({
      code: "agent_execution_invalid",
      message: `Invalid agent execution configuration in ${source.path}.`,
      details: { diagnostics },
    });
  }

  return { block: source.block as AgentExecutionConfig };
}

/**
 * Merges the blocks from lowest to highest precedence so that a higher
 * precedence block only replaces the fields it actually names. Only the known
 * execution fields are carried over; unknown config keys are ignored.
 */
function mergeExecutionBlocks(
  blocks: readonly (AgentExecutionConfig | undefined)[],
): AgentExecutionConfig | undefined {
  let merged: Record<string, unknown> | undefined;

  for (const block of blocks) {
    if (block === undefined) {
      continue;
    }

    const source = block as Record<string, unknown>;
    const next: Record<string, unknown> = { ...(merged ?? {}) };
    for (const field of EXECUTION_FIELDS) {
      const value = source[field];
      if (value !== undefined) {
        next[field] = value;
      }
    }
    merged = next;
  }

  return merged as AgentExecutionConfig | undefined;
}
