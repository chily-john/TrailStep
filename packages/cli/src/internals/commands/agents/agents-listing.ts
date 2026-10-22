import { resolveAgentTargets, type TrailStepConfig } from "@trailstep/core";

import { findAgentReferrers } from "../../agent-config/agent-referrers.js";
import { isAgentTargetsUnavailableError } from "../../agent-config/agent-targets-error.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { loadTrailStepProjectConfig } from "../../config/config.js";
import {
  configPathForScope,
  listRegisteredWorkflowEntries,
  readRawTrailStepConfigFile,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";
import {
  type ResolvedWorkflowReference,
  resolveWorkflowReference,
} from "../../workflow-resolution/workflow-resolution.js";
import { WorkflowResolutionError } from "../../workflow-resolution/workflow-resolution-error.js";

import type {
  AgentCommandArgs,
  InteractiveRow,
  InteractiveWorkflowRoleRow,
  MergedRawRoleConfig,
} from "./agents-command.types.js";
import { RESERVED_AGENT_NAMES } from "./agents-config.js";
import { isRecord, toMutableRecord } from "./record-utils.js";

export async function explainAgent(
  args: Extract<AgentCommandArgs, { readonly action: "explain" }>,
  context: CliCommandContext,
): Promise<number> {
  const configPath = configPathForScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  if (!(args.name in agents)) {
    throw new CliUsageError(`Agent ${args.name} does not exist in ${args.scope} config.`);
  }

  context.io.writeLine(`Agent ${args.name} (${args.scope})`);
  context.io.writeLine(`Config path: ${configPath}`);
  context.io.writeLine(`Entry: ${JSON.stringify(agents[args.name])}`);
  context.io.writeLine("Resolved targets:");
  const resolvedLines = explainAgentEntry(agents[args.name], agents, new Set([args.name]));
  if (resolvedLines.length === 0) {
    context.io.writeLine("  none");
  } else {
    resolvedLines.forEach((line, index) => {
      context.io.writeLine(`  ${index + 1}. ${line}`);
    });
  }

  const referrers = await findAgentReferrers(args.name, context);
  context.io.writeLine("Used by:");
  if (referrers.length === 0) {
    context.io.writeLine("  none");
  } else {
    for (const referrer of referrers) {
      context.io.writeLine(`  ${referrer.scope}: ${referrer.path}`);
    }
  }
  return 0;
}

export async function explainWorkflow(
  args: Extract<AgentCommandArgs, { readonly action: "explain-workflow" }>,
  context: CliCommandContext,
): Promise<number> {
  let resolved: ResolvedWorkflowReference | undefined;
  try {
    resolved = await resolveWorkflowReference(args.workflowRef, context);
  } catch (error) {
    if (error instanceof WorkflowResolutionError) {
      throw new CliUsageError(error.message);
    }
    throw error;
  }
  if (resolved === undefined) {
    throw new CliUsageError(`Workflow ${args.workflowRef} could not be resolved.`);
  }

  const workflowId = resolved.workflow.id;
  context.io.writeLine(`Workflow ${args.workflowRef}`);
  context.io.writeLine(`Workflow id: ${workflowId}`);

  const roles = resolved.workflow.agents;
  const roleNames = roles === undefined ? [] : Object.keys(roles).sort();
  if (roleNames.length === 0) {
    context.io.writeLine("Agent roles: none declared by the workflow.");
    return 0;
  }

  const rawConfig = await readMergedRawRoleConfig(context);
  const loadedConfig = await loadTrailStepProjectConfig(context.cwd, { homeDir: context.homeDir });

  context.io.writeLine("Agent roles:");
  for (const roleName of roleNames) {
    const role = roles?.[roleName];
    if (role === undefined) {
      continue;
    }
    context.io.writeLine(`  ${roleName} (size ${role.size})`);

    context.io.writeLine("    Configured targets/refs:");
    const configuredLines = explainWorkflowRoleConfigured(
      rawConfig,
      workflowId,
      roleName,
      role.size,
    );
    if (configuredLines.length === 0) {
      context.io.writeLine("      none");
    } else {
      configuredLines.forEach((line, index) => {
        context.io.writeLine(`      ${index + 1}. ${line}`);
      });
    }

    context.io.writeLine("    Final targets:");
    const finalLines = explainWorkflowRoleFinalTargets(
      loadedConfig.trailstepConfig,
      workflowId,
      roleName,
      role.size,
    );
    if (finalLines.length === 0) {
      context.io.writeLine("      unavailable (no agent targets resolve for this role)");
    } else {
      finalLines.forEach((line, index) => {
        context.io.writeLine(`      ${index + 1}. ${line}`);
      });
    }
  }
  return 0;
}

/**
 * Reads raw scope configs with local > project > global precedence so configured
 * entries can be shown with refs intact before core expands them.
 */
async function readMergedRawRoleConfig(context: CliCommandContext): Promise<MergedRawRoleConfig> {
  const scopeConfigs = await Promise.all(
    (["global", "project", "local"] as const).map((scope) =>
      readRawTrailStepConfigFile(configPathForScope(scope, context)),
    ),
  );

  let agents: Record<string, unknown> = {};
  const workflowBuckets: Record<string, Record<string, unknown>> = {};
  for (const config of scopeConfigs) {
    agents = { ...agents, ...toMutableRecord(config.agents) };
    for (const [workflowKey, workflowValue] of Object.entries(toMutableRecord(config.workflows))) {
      if (!isRecord(workflowValue)) {
        continue;
      }
      const existingBucket = toMutableRecord(workflowBuckets[workflowKey]);
      workflowBuckets[workflowKey] = {
        ...existingBucket,
        ...workflowValue,
        agents: {
          ...toMutableRecord(existingBucket.agents),
          ...toMutableRecord(workflowValue.agents),
        },
      };
    }
  }

  return {
    agents,
    workflowRoleEntry(workflowId: string, roleName: string): unknown {
      return toMutableRecord(toMutableRecord(workflowBuckets[workflowId]).agents)[roleName];
    },
  };
}

function explainWorkflowRoleConfigured(
  rawConfig: MergedRawRoleConfig,
  workflowId: string,
  roleName: string,
  roleSize: string,
): readonly string[] {
  const lines: string[] = [];
  const appendSource = (label: string, entry: unknown): void => {
    const rendered = explainAgentEntry(entry, rawConfig.agents, new Set());
    if (rendered.length > 0) {
      lines.push(`${label}: ${rendered.join("; ")}`);
    }
  };

  appendSource(
    `workflows.${workflowId}.agents.${roleName}`,
    rawConfig.workflowRoleEntry(workflowId, roleName),
  );
  for (const key of new Set([roleName, roleSize, "default"])) {
    appendSource(`agents.${key}`, rawConfig.agents[key]);
  }
  return lines;
}

function explainWorkflowRoleFinalTargets(
  effectiveConfig: TrailStepConfig | undefined,
  workflowId: string,
  roleName: string,
  roleSize: string,
): readonly string[] {
  if (effectiveConfig === undefined) {
    return [];
  }

  try {
    return resolveAgentTargets({ config: effectiveConfig, workflowId, roleName, roleSize }).map(
      (target) => {
        const parts = [`provider ${target.provider}`];
        if (typeof target.model === "string" && target.model.trim().length > 0) {
          parts.push(`model ${target.model}`);
        }
        if (target.thinking !== undefined) {
          parts.push(`thinking ${target.thinking}`);
        }
        return parts.join(", ");
      },
    );
  } catch (error) {
    if (isAgentTargetsUnavailableError(error)) {
      return [];
    }
    throw error;
  }
}

export function explainAgentEntry(
  value: unknown,
  agents: Record<string, unknown>,
  seenRefs: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }

  return value.map((item) => explainAgentItem(item, agents, seenRefs));
}

function explainAgentItem(
  item: unknown,
  agents: Record<string, unknown>,
  seenRefs: ReadonlySet<string>,
): string {
  if (!isRecord(item)) {
    return "invalid agent item";
  }
  if (typeof item.ref === "string") {
    if (seenRefs.has(item.ref)) {
      return `ref ${item.ref} (cycle)`;
    }
    if (!(item.ref in agents)) {
      return `ref ${item.ref} (missing)`;
    }
    const nested = explainAgentEntry(agents[item.ref], agents, new Set([...seenRefs, item.ref]));
    if (nested.length === 0) {
      return `ref ${item.ref} (empty)`;
    }
    return `ref ${item.ref} -> ${nested.join("; ")}`;
  }
  if (typeof item.provider !== "string") {
    return `inline ${JSON.stringify(item)}`;
  }

  const parts = [`provider ${item.provider}`];
  if (typeof item.model === "string" && item.model.trim().length > 0) {
    parts.push(`model ${item.model}`);
  }
  if (typeof item.thinking === "string" && item.thinking.trim().length > 0) {
    parts.push(`thinking ${item.thinking}`);
  }
  return parts.join(", ");
}

export function agentItemSummary(item: Record<string, unknown>): string {
  if (typeof item.ref === "string") {
    return `ref ${item.ref}`;
  }
  if (typeof item.provider === "string") {
    return `one-off ${item.provider}${typeof item.model === "string" ? `/${item.model}` : ""}`;
  }
  return "inline one-off";
}

export function agentEntrySummary(value: unknown): string {
  const state = agentEntryState(value);
  if (state.kind === "dash") {
    return "----";
  }
  if (state.kind === "ref") {
    return `ref ${state.ref}`;
  }
  const first = state.item;
  if (typeof first.provider === "string") {
    return `one-off ${first.provider}${typeof first.model === "string" ? `/${first.model}` : ""}`;
  }
  return "inline one-off";
}

export function agentEntryState(
  value: unknown,
):
  | { readonly kind: "dash" }
  | { readonly kind: "ref"; readonly ref: string }
  | { readonly kind: "inline"; readonly item: Record<string, unknown> } {
  const items = Array.isArray(value) ? value : [];
  if (items.length === 0) {
    return { kind: "dash" };
  }
  const first = items[0];
  if (!isRecord(first)) {
    return { kind: "inline", item: {} };
  }
  if (typeof first.ref === "string") {
    return { kind: "ref", ref: first.ref };
  }
  return { kind: "inline", item: first };
}

export async function buildInteractiveRows(
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<readonly InteractiveRow[]> {
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const agents = toMutableRecord(config.agents);
  const customNames = Object.keys(agents)
    .filter((name) => !RESERVED_AGENT_NAMES.includes(name as (typeof RESERVED_AGENT_NAMES)[number]))
    .sort();
  const namedRows = [...customNames, ...RESERVED_AGENT_NAMES].map((name) => ({
    kind: "named-agent" as const,
    name,
    label: `${name} — ${agentEntrySummary(agents[name])}`,
  }));
  const workflowRows = await buildWorkflowRows(config, context);
  return [...namedRows, ...workflowRows];
}

async function buildWorkflowRows(
  rawConfig: Record<string, unknown>,
  context: CliCommandContext,
): Promise<readonly InteractiveWorkflowRoleRow[]> {
  const rows: InteractiveWorkflowRoleRow[] = [];
  for (const entry of await listRegisteredWorkflowEntries(context)) {
    const ref = `${entry.namespace}/${entry.name}`;
    const resolved = await resolveWorkflowReference(ref, context);
    if (resolved?.workflow.agents === undefined) {
      continue;
    }
    for (const roleName of Object.keys(resolved.workflow.agents).sort()) {
      const workflowId = resolved.workflow.id;
      const workflowOverride = toMutableRecord(toMutableRecord(rawConfig.workflows)[workflowId]);
      const workflowAgents = toMutableRecord(workflowOverride.agents);
      const roleEntry = workflowAgents[roleName];
      const state = agentEntryState(roleEntry);
      rows.push({
        kind: "workflow-role",
        workflowId,
        roleName,
        label: `workflow ${workflowId} ${roleName} — ${agentEntrySummary(roleEntry)}`,
        state: state.kind,
        ...(state.kind === "ref" ? { ref: state.ref } : {}),
      });
    }
  }
  return rows;
}

export function scopeForInteractiveLabel(label: string): WorkflowRegistryScope {
  if (label === "local") {
    return "local";
  }
  if (label === "project") {
    return "project";
  }
  if (label === "global") {
    return "global";
  }
  throw new CliUsageError(`Invalid agents scope selection: ${label}`);
}
