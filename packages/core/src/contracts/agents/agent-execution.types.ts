import { TrailStepFailureError } from "../failures/failure.js";

/**
 * Opt-in lean execution context for an agent step or workflow agent role.
 *
 * The block is entirely optional: when it is omitted the provider keeps its
 * current behavior (no hygiene flags are rendered). When it is present, any
 * field that is not specified falls back to the lean default documented on
 * {@link DEFAULT_AGENT_EXECUTION}.
 */
export interface AgentExecutionConfig {
  /** Tools the agent may use. `'*'` (default) means every tool. */
  readonly tools?: "*" | readonly string[];
  /** Skills to load. Default `[]` (no skills). */
  readonly skills?: readonly string[];
  /** Whether MCP servers may connect. Default `false`. */
  readonly mcp?: boolean;
  /** Extensions to enable. Default `[]` (no extensions). */
  readonly extensions?: readonly string[];
  /**
   * Context-file loading: `true` loads everything, `'project-only'`
   * (default) restricts to the project, `false` disables loading.
   *
   * Note: provider CLIs without a dedicated project-only flag (including
   * `pi --no-context-files`, which disables AGENTS.md/CLAUDE.md discovery
   * entirely) collapse `'project-only'` to full disable when rendering
   * hygiene args. This is conservative and intentional for lean delegates.
   */
  readonly contextFiles?: boolean | "project-only";
}

/** An {@link AgentExecutionConfig} with every field resolved to its value. */
export interface ResolvedAgentExecutionConfig {
  readonly tools: "*" | readonly string[];
  readonly skills: readonly string[];
  readonly mcp: boolean;
  readonly extensions: readonly string[];
  readonly contextFiles: boolean | "project-only";
}

/** Lean defaults applied to a present execution block with omitted fields. */
export const DEFAULT_AGENT_EXECUTION: ResolvedAgentExecutionConfig = {
  tools: "*",
  skills: [],
  mcp: false,
  extensions: [],
  contextFiles: "project-only",
};

/**
 * Validates an execution block and fills omitted fields with lean defaults.
 * Invalid fields raise a `TrailStepFailureError` (code
 * `agent_execution_invalid`) whose `details.diagnostics` list every problem.
 */
export function resolveAgentExecutionConfig(
  config: AgentExecutionConfig,
): ResolvedAgentExecutionConfig {
  const diagnostics: string[] = [];

  const tools = resolveTools(config.tools, diagnostics);
  const skills = resolveStringList("skills", config.skills, diagnostics);
  const mcp = resolveBoolean("mcp", config.mcp, diagnostics);
  const extensions = resolveStringList("extensions", config.extensions, diagnostics);
  const contextFiles = resolveContextFiles(config.contextFiles, diagnostics);

  if (diagnostics.length > 0) {
    throw new TrailStepFailureError({
      code: "agent_execution_invalid",
      message: "Invalid agent execution configuration.",
      details: { diagnostics },
    });
  }

  return { tools, skills, mcp, extensions, contextFiles };
}

function resolveTools(
  value: "*" | readonly string[] | undefined,
  diagnostics: string[],
): "*" | readonly string[] {
  if (value === undefined) {
    return DEFAULT_AGENT_EXECUTION.tools;
  }
  if (value === "*") {
    return "*";
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)) {
    return value as string[];
  }
  diagnostics.push('execution.tools must be "*" or a non-empty array of tool names when present.');
  return DEFAULT_AGENT_EXECUTION.tools;
}

function resolveStringList(
  name: "skills" | "extensions",
  value: readonly string[] | undefined,
  diagnostics: string[],
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value) && value.every(isNonEmptyString)) {
    return value as string[];
  }
  diagnostics.push(`execution.${name} must be an array of non-empty strings when present.`);
  return [];
}

function resolveBoolean(name: "mcp", value: boolean | undefined, diagnostics: string[]): boolean {
  if (value === undefined) {
    return DEFAULT_AGENT_EXECUTION.mcp;
  }
  if (typeof value === "boolean") {
    return value;
  }
  diagnostics.push(`execution.${name} must be a boolean when present.`);
  return DEFAULT_AGENT_EXECUTION.mcp;
}

function resolveContextFiles(
  value: boolean | "project-only" | undefined,
  diagnostics: string[],
): boolean | "project-only" {
  if (value === undefined) {
    return DEFAULT_AGENT_EXECUTION.contextFiles;
  }
  if (typeof value === "boolean" || value === "project-only") {
    return value;
  }
  diagnostics.push('execution.contextFiles must be a boolean or "project-only" when present.');
  return DEFAULT_AGENT_EXECUTION.contextFiles;
}

function isNonEmptyString(item: unknown): boolean {
  return typeof item === "string" && item.length > 0;
}
