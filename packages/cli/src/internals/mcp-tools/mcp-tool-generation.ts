import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  normalizeShape,
  type PlainObject,
  type Schema,
  type ShapeInput,
  serializeOrdered,
  validateStructural,
} from "@trailstep/core";

/**
 * Per-workflow MCP tool JSON generation (`.trailstep/mcp/trst_<id>.json`).
 *
 * Regeneration is driven by `trailstep add` and `trailstep update --workflows`
 * only; there is no lazy startup regeneration. Each write is validated
 * structurally (see `validateStructural`) and applied atomically (tmp + rename)
 * so a malformed payload is never partially or fully written.
 */

/** Project-relative output directory for generated per-workflow tool JSON. */
export const MCP_TOOL_OUTPUT_DIR = join(".trailstep", "mcp");

/** The fields `generateMcpToolJson` needs about a workflow definition. */
export interface McpToolWorkflowInput {
  readonly id: string;
  readonly description: string;
  /** `defineWorkflow` input shape; normalized into the tool `inputSchema`. */
  readonly inputShape?: ShapeInput<PlainObject>;
  /** Ref the MCP server should run (registered ref such as `namespace/name`). */
  readonly workflowRef: string;
  /** Source content whose sha256 is recorded in `source.hash` (informational). */
  readonly sourceContent: string;
}

export interface GenerateMcpToolJsonOptions {
  /** Project root whose `.trailstep/mcp/` layer receives the file. Defaults to cwd. */
  readonly projectDir?: string;
}

export class McpToolGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolGenerationError";
  }
}

/** Structural view of a workflow definition used by the add/update hooks. */
export interface WorkflowDefinitionLike {
  readonly id: string;
  readonly description?: string;
  readonly inputShape?: ShapeInput<PlainObject>;
  /** Full-schema form some workflows use instead of the shorthand shape. */
  readonly input?: Schema<PlainObject>;
}

/**
 * Builds the `generateMcpToolJson` input from a loaded workflow definition.
 * `sourceContent` is a canonical snapshot of the definition (id, description,
 * normalized input schema) so the recorded hash is deterministic across loads;
 * it is informational only — hash comparison is never used to skip writes.
 */
export function mcpToolInputFromWorkflow(
  workflow: WorkflowDefinitionLike,
  workflowRef: string,
): McpToolWorkflowInput {
  return {
    id: workflow.id,
    description: workflow.description ?? `Run the TrailStep workflow "${workflowRef}".`,
    inputShape: workflow.inputShape ?? workflow.input ?? {},
    workflowRef,
    sourceContent: workflowSourceSnapshot(workflow),
  };
}

/** Canonical, JSON-serializable snapshot of a workflow definition for hashing. */
export function workflowSourceSnapshot(workflow: WorkflowDefinitionLike): string {
  return JSON.stringify({
    id: workflow.id,
    description: workflow.description ?? null,
    inputSchema: normalizeInputSchema(workflow.inputShape, workflow.input),
  });
}

/**
 * Writes `.trailstep/mcp/trst_<id>.json` for one workflow and returns its path.
 *
 * Throws {@link McpToolGenerationError} (without touching disk) when the input
 * is malformed, and rethrows serialization errors from `normalizeShape` before
 * any file is written. The write itself is atomic (tmp file + rename).
 */
export async function generateMcpToolJson(
  workflow: McpToolWorkflowInput,
  options?: GenerateMcpToolJsonOptions,
): Promise<string> {
  const slug = workflowSlug(workflow.id);
  if (typeof workflow.description !== "string") {
    throw new McpToolGenerationError("MCP tool JSON requires a string description.");
  }
  if (typeof workflow.workflowRef !== "string" || workflow.workflowRef.trim().length === 0) {
    throw new McpToolGenerationError("MCP tool JSON requires a non-empty workflowRef.");
  }
  if (typeof workflow.sourceContent !== "string") {
    throw new McpToolGenerationError("MCP tool JSON requires string sourceContent.");
  }

  const payload: Record<string, unknown> = {
    schemaVersion: "1.0.0",
    name: `trst_${slug}`,
    workflowRef: workflow.workflowRef,
    description: workflow.description,
    inputSchema: normalizeInputSchema(workflow.inputShape),
    source: { scope: "local", hash: hashContent(workflow.sourceContent) },
    generatedBy: "trailstep",
  };

  if (!validateStructural(payload)) {
    throw new McpToolGenerationError(
      `Refusing to write malformed MCP tool JSON for workflow "${workflow.id}".`,
    );
  }

  const outputDir = resolve(options?.projectDir ?? process.cwd(), MCP_TOOL_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, `trst_${slug}.json`);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;

  await writeFile(tmpPath, serializeOrdered(payload), "utf8");
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
  return filePath;
}

/** Normalizes a `defineWorkflow` input shape into a JSON Schema object. */
function normalizeInputSchema(
  inputShape?: ShapeInput<PlainObject>,
  input?: Schema<PlainObject>,
): Record<string, unknown> {
  return normalizeShape<PlainObject>(inputShape ?? input ?? {}).jsonSchema;
}

/**
 * File/MCP-tool safe slug for a workflow id. Fails loudly on ids with no usable
 * characters so a malformed id never produces a stray file.
 */
function workflowSlug(id: string): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new McpToolGenerationError("MCP tool JSON requires a non-empty workflow id.");
  }
  const slug = id.replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (slug.length === 0) {
    throw new McpToolGenerationError(
      `Workflow id "${id}" has no filename-safe characters; cannot name trst_<id>.json.`,
    );
  }
  return slug;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
