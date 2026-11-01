import { resolveAgentTargets, type TrailStepConfig } from "@trailstep/core";

import { findAgentReferrers } from "../../agent-config/agent-referrers.js";
import { isAgentTargetsUnavailableError } from "../../agent-config/agent-targets-error.js";
import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import {
  loadTrailStepProjectConfig,
  mergeConfigScopes,
  writeConfigScopeErrors,
} from "../../config/config.js";
import { resolveProjectRoot } from "../../project-root/project-root.js";
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
  // Without `--scope`, explain what the runtime resolves: the merged config across all scopes.
  // With `--scope`, keep the older single-file report so existing scripts see the same output.
  const scopes: readonly WorkflowRegistryScope[] =
    args.scope === undefined ? ["global", "project", "local"] : [args.scope];
  const scopeConfigs: Record<string, unknown>[] = [];
  const configuredIn: WorkflowRegistryScope[] = [];
  for (const scope of scopes) {
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
    scopeConfigs.push(config);
    if (args.name in toMutableRecord(config.agents)) {
      configuredIn.push(scope);
    }
  }
  const agents = toMutableRecord(mergeConfigScopes(scopeConfigs).agents);
  if (!(args.name in agents)) {
    throw new CliUsageError(
      args.scope === undefined
        ? `Agent ${args.name} does not exist in global, project, or local config.`
        : `Agent ${args.name} does not exist in ${args.scope} config.`,
    );
  }

  context.io.writeLine(
    args.scope === undefined
      ? `Agent ${args.name} (merged: ${configuredIn.length === 0 ? "none" : configuredIn.join(", ")})`
      : `Agent ${args.name} (${args.scope})`,
  );
  if (args.scope === undefined) {
    for (const scope of scopes) {
      context.io.writeLine(`Config path (${scope}): ${configPathForScope(scope, context)}`);
    }
  } else {
    context.io.writeLine(`Config path: ${configPathForScope(args.scope, context)}`);
  }
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
  // Both halves of the report read the project root: the display has to describe the same config
  // the runtime resolves, or it becomes another surface that can disagree with it.
  const projectRoot = await resolveProjectRoot({ cwd: context.cwd, env: context.env });
  let resolved: ResolvedWorkflowReference | undefined;
  try {
    resolved = await resolveWorkflowReference(args.workflowRef, {
      cwd: context.cwd,
      projectRoot,
      homeDir: context.homeDir,
    });
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

  const rawScopes = await readRawScopeConfigs(context, projectRoot);
  // The configured entries come from the raw scopes (refs stay unexpanded), but the merge has
  // to be the runtime's merge. A third, deeper hand-rolled merge here is what let this display
  // list roles the runtime would never see.
  const mergedRaw = mergeConfigScopes(rawScopes.map((entry) => entry.config));
  const rawConfig = rawRoleConfigFor(mergedRaw);
  const loadedConfig = await loadTrailStepProjectConfig(projectRoot, {
    homeDir: context.homeDir,
  });
  writeConfigScopeErrors(context.io, loadedConfig.configErrors);

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

    context.io.writeLine("    Sources:");
    for (const line of explainWorkflowRoleSources(rawScopes, workflowId, roleName, role.size)) {
      context.io.writeLine(`      ${line}`);
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

interface RawScopeConfig {
  readonly scope: WorkflowRegistryScope;
  readonly config: Record<string, unknown>;
}

/**
 * Reads every scope config raw and independently so configured entries can be shown with refs
 * intact before core expands them.
 */
async function readRawScopeConfigs(
  context: CliCommandContext,
  projectRoot: string,
): Promise<readonly RawScopeConfig[]> {
  const scopes = ["global", "project", "local"] as const;
  return await Promise.all(
    scopes.map(async (scope) => ({
      scope,
      config: await readRawTrailStepConfigFile(
        configPathForScope(scope, { cwd: projectRoot, homeDir: context.homeDir }),
      ),
    })),
  );
}

function rawRoleConfigFor(mergedRaw: Readonly<Record<string, unknown>>): MergedRawRoleConfig {
  return {
    agents: toMutableRecord(mergedRaw.agents),
    workflowRoleEntry(workflowId: string, roleName: string): unknown {
      const workflow = toMutableRecord(toMutableRecord(mergedRaw.workflows)[workflowId]);
      return toMutableRecord(workflow.agents)[roleName];
    },
  };
}

const CONFIG_PATH_LABELS: Readonly<Record<WorkflowRegistryScope, string>> = {
  global: "~/.trailstep/config.json",
  project: ".trailstep/config.json",
  local: ".trailstep/config-local.json",
};

const SOURCE_SCOPE_ORDER: readonly WorkflowRegistryScope[] = ["project", "local", "global"];

/**
 * Names which scope supplied (or did not supply) an agent entry for one workflow role.
 *
 * This is the block that makes a scope-precedence bug visible: before it existed, a display that
 * disagreed with the runtime looked exactly like a display that agreed.
 */
function explainWorkflowRoleSources(
  scopes: readonly RawScopeConfig[],
  workflowId: string,
  roleName: string,
  roleSize: string,
): readonly string[] {
  const pathWidth = Math.max(
    ...SOURCE_SCOPE_ORDER.map((scope) => CONFIG_PATH_LABELS[scope].length),
  );

  return SOURCE_SCOPE_ORDER.map((scope) => {
    const config = scopes.find((entry) => entry.scope === scope)?.config ?? {};
    const keys = configuredRoleKeys(config, workflowId, roleName, roleSize);
    const label = `${scope.padEnd(9)}${CONFIG_PATH_LABELS[scope].padEnd(pathWidth)}`;
    return keys.length === 0
      ? `${label}   (no agent for this role)`
      : `${label}   ${keys.join(", ")}`;
  });
}

function configuredRoleKeys(
  config: Readonly<Record<string, unknown>>,
  workflowId: string,
  roleName: string,
  roleSize: string,
): readonly string[] {
  const keys: string[] = [];
  const workflowRole = toMutableRecord(
    toMutableRecord(toMutableRecord(config.workflows)[workflowId]).agents,
  )[roleName];
  if (hasAgentEntry(workflowRole)) {
    keys.push(`workflows.${workflowId}.agents.${roleName}`);
  }

  const agents = toMutableRecord(config.agents);
  for (const key of new Set([roleName, roleSize, "default"])) {
    if (hasAgentEntry(agents[key])) {
      keys.push(`agents.${key}`);
    }
  }

  return keys;
}

function hasAgentEntry(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
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
