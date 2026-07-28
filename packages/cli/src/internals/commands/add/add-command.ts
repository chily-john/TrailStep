import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  providerRegistry,
  resolveAgentTargets,
  type StepKitConfig,
  type WorkflowAgentRole,
} from "@stepkit/core";

import {
  type ConfiguredCustomProvider,
  configureLiteralAgentTarget,
} from "../../agent-config/configure-target-flow.js";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { loadStepKitProjectConfig } from "../../config/config.js";
import {
  promptMultiSelect,
  promptSelect,
  promptText,
  promptYesNo,
} from "../../prompts/prompt-helpers.js";
import {
  assertNamespaceMatchesScope,
  configPathForScope,
  findExistingRegistrationScope,
  readRawStepKitConfigFile,
  toMutableWorkflowRegistry,
  type WorkflowRegistryScope,
  writeRawStepKitConfigFile,
} from "../../workflow-registry/workflow-registry.js";
import {
  type BundleWorkflowSpecifier,
  loadBundleWorkflow,
  readBundleWorkflowManifest,
  resolvePackageJsonPath,
} from "../../workflow-resolution/bundle-resolver.js";
import { loadDirectWorkflowExports } from "../../workflow-resolution/direct-file-resolver.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";
import { WorkflowResolutionError } from "../../workflow-resolution/workflow-resolution-error.js";
import {
  distributeWorkflowSkill,
  type SkillsCliDistributionTarget,
} from "../../workflow-skills/skills-cli.js";
import {
  type WorkflowSkillMetadata,
  workflowSkillName,
} from "../../workflow-skills/workflow-skill-content.js";
import { writeProjectWorkflowSkill } from "../../workflow-skills/workflow-skill-writer.js";

interface AddCommandArgs {
  readonly source: string;
  readonly scope?: WorkflowRegistryScope;
  readonly namespace?: string;
  readonly name?: string;
  readonly workflow?: string;
  readonly force: boolean;
  readonly projectSkill: boolean;
  readonly userSkill: boolean;
  readonly projectSkillExplicit: boolean;
  readonly userSkillExplicit: boolean;
}

interface ResolvedAddCommandArgs {
  readonly source: string;
  readonly scope: WorkflowRegistryScope;
  readonly namespace: string;
  readonly name: string;
  readonly workflow?: string;
  readonly force: boolean;
  readonly projectSkill: boolean;
  readonly userSkill: boolean;
}

interface AddRegistration {
  readonly registryTarget: AddRegistryTarget;
  readonly name: string;
}

const SCOPE_PROMPT_LABEL =
  "Where should this workflow be registered? (local = just you on this repo, " +
  "project = shared with your team, global = global across all your projects)";
const PROVIDER_CHOICES = Object.keys(providerRegistry).sort();
const SELECT_ALL_WORKFLOWS_CHOICE = "Select all";

export const addCommand: CliCommand<AddCommandArgs> = {
  name: "add",
  parseArgs(argv: readonly string[]): AddCommandArgs {
    if (argv[0] !== "add") {
      throw new CliUsageError("Expected add command.");
    }

    const source = argv[1];
    if (!source) {
      throw new CliUsageError(
        "stepkit add requires a workflow file, bundle path, or bundle package.",
      );
    }

    const flags = parseFlags(argv.slice(2));
    const scope = flags.scope;
    if (scope !== undefined && scope !== "local" && scope !== "project" && scope !== "global") {
      throw new CliUsageError(
        "stepkit add requires --scope local, --scope project, or --scope global.",
      );
    }

    return {
      source,
      ...(scope === undefined ? {} : { scope }),
      ...(flags.namespace === undefined ? {} : { namespace: flags.namespace }),
      ...(flags.name === undefined ? {} : { name: flags.name }),
      workflow: flags.workflow,
      force: flags.force === "true",
      projectSkill: flags["project-skill"] === "true",
      userSkill: flags["user-skill"] === "true",
      projectSkillExplicit: flags["project-skill"] === "true",
      userSkillExplicit: flags["user-skill"] === "true",
    };
  },
  async run(args: AddCommandArgs, context: CliCommandContext): Promise<number> {
    const scope =
      args.scope ??
      (await promptSelect(
        SCOPE_PROMPT_LABEL,
        ["local", "project", "global"] as const,
        context.prompts,
        "stepkit add requires --scope <local|project|global>.",
      ));

    const registryTargets = await validateAndBuildRegistryTargets(
      { source: args.source, workflow: args.workflow },
      context.cwd,
      context,
    );

    if (args.name !== undefined && registryTargets.length > 1) {
      throw new CliUsageError("stepkit add --name can only be used when registering one workflow.");
    }

    const namespace = await resolveNamespace(args.namespace, scope, context.prompts);
    assertNamespaceMatchesScope(namespace, scope);

    const resolvedArgs = await resolveSkillArgs(args, context.prompts);
    const registrations = registryTargets.map((registryTarget) => ({
      registryTarget,
      name: args.name ?? deriveDefaultWorkflowName(registryTarget.workflow),
    }));

    const successfulRegistrations: AddRegistration[] = [];
    let skippedConflicts = 0;
    for (const registration of registrations) {
      const existingScope = await findExistingRegistrationScope(
        namespace,
        registration.name,
        scope,
        {
          cwd: context.cwd,
          homeDir: context.homeDir,
        },
      );
      if (!args.force && existingScope !== undefined) {
        skippedConflicts += 1;
        context.io.writeError(
          `Warning: skipped ${namespace}/${registration.name} because it already exists in ${existingScope} config. Use --force to replace it.`,
        );
        continue;
      }
      successfulRegistrations.push(registration);
    }

    const configPath = configPathForScope(scope, context);
    const config = await readRawStepKitConfigFile(configPath);
    const workflows = toMutableWorkflowRegistry(config.workflows);
    const namespaceBucket = workflows[namespace] ?? {};

    if (successfulRegistrations.length > 0) {
      workflows[namespace] = {
        ...namespaceBucket,
        ...Object.fromEntries(
          successfulRegistrations.map((registration) => [
            registration.name,
            registration.registryTarget.targetRef,
          ]),
        ),
      };
      await writeRawStepKitConfigFile(configPath, { ...config, workflows });
    }

    for (const registration of successfulRegistrations) {
      context.io.writeLine(
        `Registered ${namespace}/${registration.name} -> ${registration.registryTarget.targetRef} in ${scope} config.`,
      );
    }

    await promptForUncoveredWorkflowRolesForRegistrations(
      { scope, registrations: successfulRegistrations },
      context,
    );

    let skillWarnings = 0;
    for (const registration of successfulRegistrations) {
      const finalArgs: ResolvedAddCommandArgs = {
        source: args.source,
        scope,
        namespace,
        name: registration.name,
        workflow: args.workflow,
        force: args.force,
        projectSkill: resolvedArgs.projectSkill,
        userSkill: resolvedArgs.userSkill,
      };

      if (finalArgs.projectSkill || finalArgs.userSkill) {
        skillWarnings += await tryWriteAndDistributeWorkflowSkill(
          finalArgs,
          registration.registryTarget,
          context,
        );
      }
    }

    if (registrations.length > 1 || skippedConflicts > 0) {
      context.io.writeLine(
        `Summary: registered ${successfulRegistrations.length}, skipped conflicts ${skippedConflicts}, skill warnings ${skillWarnings}.`,
      );
    }

    return 0;
  },
};

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--force") {
      flags.force = "true";
      continue;
    }

    if (option === "--project-skill" || option === "--user-skill") {
      flags[option.slice(2)] = "true";
      continue;
    }

    if (
      option !== "--scope" &&
      option !== "--namespace" &&
      option !== "--name" &&
      option !== "--workflow"
    ) {
      throw new CliUsageError(`Unknown option for stepkit add: ${option ?? ""}`);
    }

    const value = argv[index + 1];
    if (!value) {
      throw new CliUsageError(`Missing value for ${option}.`);
    }

    flags[option.slice(2)] = value;
    index += 1;
  }

  return flags;
}

async function resolveNamespace(
  explicitNamespace: string | undefined,
  scope: WorkflowRegistryScope,
  prompts: CliCommandContext["prompts"],
): Promise<string> {
  if (explicitNamespace !== undefined) {
    return explicitNamespace;
  }
  if (scope !== "global") {
    return "project";
  }
  if (prompts === undefined) {
    return "global";
  }

  const wantsNamespace = await promptYesNo(
    "Add a namespace to avoid collisions?",
    prompts,
    "stepkit add requires --namespace <namespace> when scope is global and not run interactively.",
  );
  if (!wantsNamespace) {
    return "global";
  }
  return promptText(
    "Namespace",
    undefined,
    prompts,
    "stepkit add requires --namespace <namespace>.",
  );
}

function deriveDefaultWorkflowName(workflow: WorkflowSkillMetadata | undefined): string {
  const id = workflow?.id;
  if (id === undefined) {
    throw new CliUsageError("stepkit add requires --name <name> for this source.");
  }
  if (/[/#:]/u.test(id)) {
    throw new CliUsageError(
      `Workflow id "${id}" contains a reserved character (/, #, or :) and can't be used as a ` +
        "default registration name. Pass --name <name> explicitly.",
    );
  }
  if (isDirectWorkflowFileReference(id)) {
    throw new CliUsageError(
      `Workflow id "${id}" looks like a file path and can't be used as a default registration ` +
        "name. Pass --name <name> explicitly.",
    );
  }
  return id;
}

interface ResolvedSkillArgs {
  readonly projectSkill: boolean;
  readonly userSkill: boolean;
}

async function resolveSkillArgs(
  args: AddCommandArgs,
  prompts: CliCommandContext["prompts"],
): Promise<ResolvedSkillArgs> {
  const promptSkillChoices =
    prompts !== undefined && !args.projectSkillExplicit && !args.userSkillExplicit;

  if (!promptSkillChoices) {
    return { projectSkill: args.projectSkill, userSkill: args.userSkill };
  }

  return {
    projectSkill: await promptYesNo(
      "Add to project skills?",
      prompts,
      "stepkit add requires --project-skill.",
    ),
    userSkill: await promptYesNo(
      "Add to user skills?",
      prompts,
      "stepkit add requires --user-skill.",
    ),
  };
}

interface PromptForUncoveredWorkflowRolesForRegistrationsOptions {
  readonly scope: WorkflowRegistryScope;
  readonly registrations: readonly AddRegistration[];
}

interface UncoveredWorkflowRoleGroup {
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
  readonly workflowIds: Set<string>;
}

async function promptForUncoveredWorkflowRolesForRegistrations(
  options: PromptForUncoveredWorkflowRolesForRegistrationsOptions,
  context: CliCommandContext,
): Promise<void> {
  if (options.registrations.length === 0) {
    return;
  }

  const loadedConfig = await loadStepKitProjectConfig(context.cwd, { homeDir: context.homeDir });
  const effectiveConfig = loadedConfig.stepkitConfig;
  if (effectiveConfig === undefined) {
    return;
  }

  const roleGroups = collectUncoveredWorkflowRoleGroups(options.registrations, effectiveConfig);
  for (const roleName of Object.keys(roleGroups).sort()) {
    const group = roleGroups[roleName];
    if (group === undefined) {
      continue;
    }
    const workflowIds = [...group.workflowIds];
    const entry = await promptForWorkflowRoleMapping(
      {
        scope: options.scope,
        workflowId: workflowIds[0] ?? "",
        roleName: group.roleName,
        role: group.role,
      },
      context,
    );
    if (entry === undefined) {
      continue;
    }
    for (const workflowId of workflowIds) {
      await writeWorkflowRoleMapping(options.scope, workflowId, group.roleName, entry, context);
    }
  }
}

function collectUncoveredWorkflowRoleGroups(
  registrations: readonly AddRegistration[],
  effectiveConfig: StepKitConfig,
): Record<string, UncoveredWorkflowRoleGroup> {
  const groups: Record<string, UncoveredWorkflowRoleGroup> = {};

  for (const registration of registrations) {
    const workflow = registration.registryTarget.workflow;
    const workflowAgents = workflow?.agents;
    if (
      workflow === undefined ||
      workflowAgents === undefined ||
      Object.keys(workflowAgents).length === 0
    ) {
      continue;
    }

    for (const roleName of Object.keys(workflowAgents).sort()) {
      const role = workflowAgents[roleName];
      if (role === undefined || !isWorkflowAgentRole(role)) {
        continue;
      }
      if (isRoleCoveredByEffectiveConfig(effectiveConfig, workflow.id, roleName, role)) {
        continue;
      }

      groups[roleName] = groups[roleName] ?? {
        roleName,
        role,
        workflowIds: new Set<string>(),
      };
      groups[roleName].workflowIds.add(workflow.id);
    }
  }

  return groups;
}

function isRoleCoveredByEffectiveConfig(
  config: StepKitConfig,
  workflowId: string,
  roleName: string,
  role: WorkflowAgentRole,
): boolean {
  try {
    resolveAgentTargets({ config, workflowId, roleName, roleSize: role.size });
    return true;
  } catch (error) {
    if (isAgentTargetsUnavailable(error)) {
      return false;
    }
    throw error;
  }
}

function isAgentTargetsUnavailable(error: unknown): boolean {
  return (
    isRecord(error) && isRecord(error.failure) && error.failure.code === "agent_targets_unavailable"
  );
}

interface PromptForWorkflowRoleMappingOptions {
  readonly scope: WorkflowRegistryScope;
  readonly workflowId: string;
  readonly roleName: string;
  readonly role: WorkflowAgentRole;
}

async function promptForWorkflowRoleMapping(
  options: PromptForWorkflowRoleMappingOptions,
  context: CliCommandContext,
): Promise<readonly Record<string, unknown>[] | undefined> {
  if (context.prompts === undefined) {
    throw new CliUsageError(
      `Workflow ${options.workflowId} role ${options.roleName} has no configured agent targets; run interactively or configure agents first.`,
    );
  }

  const action = await context.prompts.select(workflowRolePrompt(options), [
    "Use named agent",
    "Create new agent",
    "Skip",
  ]);
  if (action === "Skip") {
    return undefined;
  }
  if (action === "Use named agent") {
    const namedAgent = await context.prompts.select(
      `Named agent for workflow role ${options.roleName}`,
      await listNamedAgentChoices(context),
    );
    return [{ ref: namedAgent }];
  }

  const name = (
    await context.prompts.text(`New agent name for workflow role ${options.roleName}`)
  ).trim();
  if (name.length === 0) {
    throw new CliUsageError("New agent name is required.");
  }
  const configured = await configureLiteralAgentTarget({
    prompts: context.prompts,
    providerChoices: PROVIDER_CHOICES,
  });
  await writeNamedAgent(
    options.scope,
    name,
    [{ ...configured.target }],
    context,
    configured.customProvider,
  );
  return [{ ref: name }];
}

function workflowRolePrompt(options: PromptForWorkflowRoleMappingOptions): string {
  return [
    `Configure workflow role ${options.roleName} (${options.role.size})`,
    options.role.description === undefined ? undefined : `— ${options.role.description}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

async function listNamedAgentChoices(context: CliCommandContext): Promise<readonly string[]> {
  const names = new Set<string>();
  for (const scope of ["local", "project", "global"] as const) {
    const config = await readRawStepKitConfigFile(configPathForScope(scope, context));
    for (const name of Object.keys(toMutableRecord(config.agents))) {
      names.add(name);
    }
  }
  return [...names].sort();
}

async function writeNamedAgent(
  scope: WorkflowRegistryScope,
  name: string,
  entry: readonly Record<string, unknown>[],
  context: CliCommandContext,
  customProvider?: ConfiguredCustomProvider,
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawStepKitConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  agents[name] = entry;
  if (customProvider === undefined) {
    await writeRawStepKitConfigFile(configPath, { ...config, agents });
    return;
  }
  const customProviders = toMutableRecord(config.customProviders);
  customProviders[customProvider.name] = { ...customProvider.config };
  await writeRawStepKitConfigFile(configPath, { ...config, customProviders, agents });
}

async function writeWorkflowRoleMapping(
  scope: WorkflowRegistryScope,
  workflowId: string,
  roleName: string,
  entry: readonly Record<string, unknown>[],
  context: CliCommandContext,
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawStepKitConfigFile(configPath);
  const workflows = toMutableRecord(config.workflows);
  const workflowConfig = toMutableRecord(workflows[workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  workflowAgents[roleName] = entry;
  workflows[workflowId] = { ...workflowConfig, agents: workflowAgents };
  await writeRawStepKitConfigFile(configPath, { ...config, workflows });
}

function isWorkflowAgentRole(value: unknown): value is WorkflowAgentRole {
  return isRecord(value) && typeof value.size === "string";
}

async function tryWriteAndDistributeWorkflowSkill(
  args: ResolvedAddCommandArgs,
  registryTarget: AddRegistryTarget,
  context: CliCommandContext,
): Promise<number> {
  const skillName = workflowSkillName(args.namespace, args.name);

  let writtenSkill: { readonly skillName: string; readonly skillDirectory: string };
  try {
    const workflow =
      registryTarget.bundleSpecifier === undefined
        ? registryTarget.workflow
        : (
            await loadBundleWorkflow(registryTarget.bundleSpecifier, {
              cwd: context.cwd,
              freshImport: true,
            })
          ).workflow;

    writtenSkill = await writeProjectWorkflowSkill({
      cwd: context.cwd,
      registeredRef: registryTarget.targetRef,
      namespace: args.namespace,
      name: args.name,
      workflow: workflow as WorkflowSkillMetadata | undefined,
    });
  } catch {
    context.io.writeError(
      `Warning: registered ${args.namespace}/${args.name} but could not write project workflow skill ${skillName}.`,
    );
    return 1;
  }

  warnForSkillScopeMismatch(args, writtenSkill.skillName, context);

  let warnings = 0;
  if (args.projectSkill) {
    warnings += await tryDistributeWorkflowSkill(args, writtenSkill.skillDirectory, "project", context);
  }
  if (args.userSkill) {
    warnings += await tryDistributeWorkflowSkill(args, writtenSkill.skillDirectory, "user", context);
  }
  return warnings;
}

function warnForSkillScopeMismatch(
  args: ResolvedAddCommandArgs,
  skillName: string,
  context: CliCommandContext,
): void {
  if (args.projectSkill && (args.scope === "global" || args.scope === "local")) {
    context.io.writeError(
      `Warning: project workflow skill ${skillName} points at a ${args.scope}-scoped registration; teammates may not resolve it.`,
    );
  }
  if (args.userSkill && (args.scope === "project" || args.scope === "local")) {
    context.io.writeError(
      `Warning: user workflow skill ${skillName} points at a ${args.scope}-scoped registration and only works from this project.`,
    );
  }
}

async function tryDistributeWorkflowSkill(
  args: ResolvedAddCommandArgs,
  skillDirectory: string,
  target: SkillsCliDistributionTarget,
  context: CliCommandContext,
): Promise<number> {
  const skillName = workflowSkillName(args.namespace, args.name);

  try {
    await distributeWorkflowSkill({
      skillDirectory,
      target,
      resolver: context.skillsCliResolver,
      runner: context.skillsCliProcessRunner,
    });
    return 0;
  } catch (error) {
    context.io.writeError(
      `Warning: registered ${args.namespace}/${args.name} but could not distribute ${target} workflow skill ${skillName}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  }
}

interface AddRegistryTarget {
  readonly targetRef: string;
  readonly workflow?: WorkflowSkillMetadata;
  readonly bundleSpecifier?: BundleWorkflowSpecifier;
}

interface AddWorkflowCandidate extends AddRegistryTarget {
  readonly selectionName: string;
  readonly sourceKind: "bundle" | "direct";
}

interface SourceResolutionArgs {
  readonly source: string;
  readonly workflow?: string;
}

async function validateAndBuildRegistryTargets(
  args: SourceResolutionArgs,
  cwd: string,
  context: CliCommandContext,
): Promise<readonly AddRegistryTarget[]> {
  const candidates = await listAddWorkflowCandidates(args.source, cwd);
  return selectAddWorkflowCandidates(candidates, args, context);
}

async function listAddWorkflowCandidates(
  source: string,
  cwd: string,
): Promise<readonly AddWorkflowCandidate[]> {
  if (await isBundleSource(source, cwd)) {
    return listBundleAddWorkflowCandidates(source, cwd);
  }
  return listDirectAddWorkflowCandidates(source, cwd);
}

async function listBundleAddWorkflowCandidates(
  source: string,
  cwd: string,
): Promise<readonly AddWorkflowCandidate[]> {
  const workflowNames = await readBundleWorkflowNames(source, cwd);
  const candidates: AddWorkflowCandidate[] = [];

  for (const workflowName of workflowNames) {
    const specifier = bundleWorkflowSpecifier(source, workflowName);
    const bundleWorkflow = await loadBundleWorkflow(specifier, { cwd });
    candidates.push({
      selectionName: workflowName,
      sourceKind: "bundle",
      targetRef: `${source}#${workflowName}`,
      workflow: bundleWorkflow.workflow as WorkflowSkillMetadata,
      bundleSpecifier: specifier,
    });
  }

  return candidates;
}

async function listDirectAddWorkflowCandidates(
  source: string,
  cwd: string,
): Promise<readonly AddWorkflowCandidate[]> {
  const directWorkflowExports = await loadDirectWorkflowExports(source, { cwd });
  return directWorkflowExports.workflows.map((entry) => ({
    selectionName: entry.name,
    sourceKind: "direct",
    targetRef:
      directWorkflowExports.workflows.length === 1 && directWorkflowExports.exportName === undefined
        ? source
        : `${source}#${entry.name}`,
    workflow: entry.workflow as WorkflowSkillMetadata,
  }));
}

async function selectAddWorkflowCandidates(
  candidates: readonly AddWorkflowCandidate[],
  args: SourceResolutionArgs,
  context: CliCommandContext,
): Promise<readonly AddRegistryTarget[]> {
  if (args.workflow !== undefined) {
    return selectCandidatesFromWorkflowFlag(candidates, args.workflow);
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new CliUsageError(
        `Source ${args.source} contains multiple workflows. Choose one with --workflow <workflow>.`,
      );
    }
    return [candidate];
  }

  const selectedNames = await promptMultiSelect(
    workflowPromptLabel(candidates),
    [SELECT_ALL_WORKFLOWS_CHOICE, ...candidates.map((candidate) => candidate.selectionName)],
    context.prompts,
    `Source ${args.source} contains multiple workflows. Choose one or more with --workflow <workflow>.`,
  );

  if (selectedNames.includes(SELECT_ALL_WORKFLOWS_CHOICE)) {
    return candidates;
  }

  return selectedNames.map((workflowName) => findAddWorkflowCandidate(candidates, workflowName));
}

function selectCandidatesFromWorkflowFlag(
  candidates: readonly AddWorkflowCandidate[],
  workflowFlag: string,
): readonly AddWorkflowCandidate[] {
  if (workflowFlag === "*") {
    return candidates;
  }

  const selectedNames = workflowFlag.split(",").map((part) => part.trim());
  if (selectedNames.some((name) => name.length === 0)) {
    throw new CliUsageError("stepkit add --workflow entries must be non-empty workflow names.");
  }
  const selectedNameSet = new Set(selectedNames);
  if (selectedNameSet.size !== selectedNames.length) {
    throw new CliUsageError("stepkit add --workflow entries must not contain duplicates.");
  }

  for (const selectedName of selectedNames) {
    findAddWorkflowCandidate(candidates, selectedName);
  }

  return candidates.filter((candidate) => selectedNameSet.has(candidate.selectionName));
}

function findAddWorkflowCandidate(
  candidates: readonly AddWorkflowCandidate[],
  workflowName: string,
): AddWorkflowCandidate {
  const candidate = candidates.find((entry) => entry.selectionName === workflowName);
  if (candidate === undefined) {
    throw new WorkflowResolutionError(
      `Workflow not found: ${workflowName}. ${formatAvailableWorkflowCandidates(candidates)}`,
    );
  }

  return candidate;
}

function workflowPromptLabel(candidates: readonly AddWorkflowCandidate[]): string {
  return candidates.every((candidate) => candidate.sourceKind === "bundle")
    ? "Bundle workflow"
    : "Workflow";
}

function formatAvailableWorkflowCandidates(candidates: readonly AddWorkflowCandidate[]): string {
  if (candidates.length === 0) {
    return "Available workflows: none.";
  }
  return `Available workflows: ${candidates.map((candidate) => candidate.selectionName).join(", ")}.`;
}

async function isBundleSource(source: string, cwd: string): Promise<boolean> {
  if (!isDirectWorkflowFileReference(source)) {
    return true;
  }

  const sourcePath = resolve(cwd, source);
  let sourceStats: Awaited<ReturnType<typeof stat>>;
  try {
    sourceStats = await stat(sourcePath);
  } catch {
    return false;
  }

  if (!sourceStats.isDirectory()) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      await readFile(resolve(sourcePath, "package.json"), "utf8"),
    ) as unknown;
    const stepkit = isRecord(parsed) ? parsed.stepkit : undefined;
    return isRecord(stepkit) && isRecord(stepkit.workflows);
  } catch {
    return false;
  }
}

async function readBundleWorkflowNames(source: string, cwd: string): Promise<string[]> {
  const packageJsonPath = resolvePackageJsonPath(source, cwd);
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  } catch (error) {
    throw new WorkflowResolutionError(
      `Unable to read bundle package manifest for ${source}: ${packageJsonPath}`,
      { cause: error },
    );
  }

  return Object.keys(readBundleWorkflowManifest(parsed, source));
}

function bundleWorkflowSpecifier(source: string, workflowName: string): BundleWorkflowSpecifier {
  return { packageName: source, workflowName };
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
