import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  providerRegistry,
  resolveAgentTargets,
  type TrailStepConfig,
  type WorkflowAgentRole,
} from "@trailstep/core";

import {
  type ConfiguredCustomProvider,
  configureLiteralAgentTarget,
} from "../../agent-config/configure-target-flow.js";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { loadTrailStepProjectConfig } from "../../config/config.js";
import {
  promptMultiSelect,
  promptSelect,
  promptText,
  promptYesNo,
} from "../../prompts/prompt-helpers.js";
import { workflowPackageInstallRootForScope } from "../../workflow-packages/install-root.js";
import {
  type InstalledNpmWorkflowPackage,
  installNpmWorkflowPackage,
  WorkflowPackageInstallError,
} from "../../workflow-packages/npm-package-installer.js";
import {
  createWorkflowPackageInstallSnapshot,
  rollbackWorkflowPackageInstall,
  type WorkflowPackageInstallSnapshot,
} from "../../workflow-packages/package-install-rollback.js";
import {
  type ParsedWorkflowPackageRef,
  parseWorkflowPackageRef,
} from "../../workflow-packages/package-ref.js";
import {
  assertNamespaceMatchesScope,
  configPathForScope,
  findExistingRegistrationScope,
  readRawTrailStepConfigFile,
  type WorkflowPackageRegistryMetadata,
  type WorkflowRegistryScope,
  writeRawTrailStepConfigFile,
  writeWorkflowRegistryEntries,
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
  readonly yes: boolean;
  readonly dryRun: boolean;
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
const EXISTING_PACKAGE_PROMPT_CHOICES = [
  "Reuse installed package",
  "Reinstall/upgrade",
  "Cancel",
] as const;
const REGISTRATION_CONFLICT_PROMPT_CHOICES = [
  "Replace existing registration",
  "Skip this workflow",
  "Cancel add",
] as const;

export const addCommand: CliCommand<AddCommandArgs> = {
  name: "add",
  parseArgs(argv: readonly string[]): AddCommandArgs {
    if (argv[0] !== "add") {
      throw new CliUsageError("Expected add command.");
    }

    const parsedInvocation = splitAddSourceAndFlagArgs(argv.slice(1));
    if (parsedInvocation.source === undefined) {
      throw new CliUsageError(
        "trailstep add requires a workflow file, bundle path, bundle package, npm package spec, or GitHub package spec.",
      );
    }

    const flags = parseFlags(parsedInvocation.flagArgs);
    const scope = flags.scope;
    if (scope !== undefined && scope !== "local" && scope !== "project" && scope !== "global") {
      throw new CliUsageError(
        "trailstep add requires --scope local, --scope project, or --scope global.",
      );
    }

    return {
      source: parsedInvocation.source,
      ...(scope === undefined ? {} : { scope }),
      ...(flags.namespace === undefined ? {} : { namespace: flags.namespace }),
      ...(flags.name === undefined ? {} : { name: flags.name }),
      workflow: flags.workflow,
      force: flags.force === "true",
      projectSkill: flags["project-skill"] === "true",
      userSkill: flags["user-skill"] === "true",
      projectSkillExplicit: flags["project-skill"] === "true",
      userSkillExplicit: flags["user-skill"] === "true",
      yes: flags.yes === "true",
      dryRun: flags["dry-run"] === "true",
    };
  },
  async run(args: AddCommandArgs, context: CliCommandContext): Promise<number> {
    const scope =
      args.scope ??
      (args.yes
        ? "project"
        : await promptSelect(
            SCOPE_PROMPT_LABEL,
            ["local", "project", "global"] as const,
            context.prompts,
            "trailstep add requires --scope <local|project|global>.",
          ));

    if (args.dryRun) {
      return runPackageAddDryRun(args, scope, context);
    }

    let preparedSource: PreparedAddSource;
    try {
      preparedSource = await prepareAddSource(args.source, scope, context, { headless: args.yes });
    } catch (error) {
      if (error instanceof WorkflowPackageInstallError) {
        context.io.writeError(error.message);
        return 1;
      }
      throw error;
    }
    if (preparedSource.status === "cancelled") {
      return 0;
    }
    let registrationPlan: AddRegistrationPlan;
    try {
      registrationPlan = await buildAddRegistrationPlan({ args, scope, preparedSource, context });
    } catch (error) {
      await reportPackageAddInstallCleanup(preparedSource, context);
      throw error;
    }
    if (registrationPlan.status === "cancelled") {
      await reportPackageAddInstallCleanup(preparedSource, context);
      return 0;
    }

    const {
      namespace,
      registrations,
      registrationConflicts,
      successfulRegistrations,
      skippedConflicts,
      resolvedArgs,
    } = registrationPlan;

    if (successfulRegistrations.length > 0) {
      await writeWorkflowRegistryEntries(
        scope,
        successfulRegistrations.map((registration) => ({
          namespace,
          name: registration.name,
          targetRef: registration.registryTarget.targetRef,
          ...(registration.registryTarget.metadata === undefined
            ? {}
            : { metadata: registration.registryTarget.metadata }),
        })),
        context,
      );
    } else {
      await reportPackageAddInstallCleanup(preparedSource, context);
    }

    for (const registration of successfulRegistrations) {
      context.io.writeLine(
        `Registered ${namespace}/${registration.name} -> ${registration.registryTarget.targetRef} in ${scope} config.`,
      );
    }

    if (!args.yes) {
      await promptForUncoveredWorkflowRolesForRegistrations(
        { scope, registrations: successfulRegistrations },
        context,
      );
    }

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

    if (registrations.length > 1 || skippedConflicts > 0 || registrationConflicts.length > 0) {
      context.io.writeLine(
        `Summary: registered ${successfulRegistrations.length}, skipped conflicts ${skippedConflicts}, skill warnings ${skillWarnings}.`,
      );
    }

    return 0;
  },
};

async function runPackageAddDryRun(
  args: AddCommandArgs,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<number> {
  const packageRef = parseWorkflowPackageRef(args.source);
  if (packageRef === undefined) {
    throw new CliUsageError(
      "trailstep add --dry-run is package-backed only; direct workflow files/directories and local bundle refs are not supported in dry-run yet.",
    );
  }

  const installRoot = workflowPackageInstallRootForScope(scope, context);
  const existingPackage = await readExistingInstalledNpmWorkflowPackage(
    packageRef,
    scope,
    installRoot,
  );

  context.io.writeLine("Dry run: package-backed add plan.");
  context.io.writeLine(`Scope: ${scope}`);
  context.io.writeLine(`Source type: ${packageRef.sourceType}`);
  context.io.writeLine(`Requested spec: ${packageRef.requestedSpec}`);
  if (packageRef.sourceType === "npm") {
    context.io.writeLine(`Package: ${packageRef.packageName}`);
  } else {
    context.io.writeLine(`GitHub ref: ${packageRef.githubRef}`);
  }
  context.io.writeLine(`Install root: ${installRoot}`);

  if (existingPackage === undefined) {
    context.io.writeLine(`Would install ${packageRef.requestedSpec} into ${installRoot}.`);
    context.io.writeLine(
      "Workflow discovery: skipped because dry-run will not install packages. Run without --dry-run to discover workflows and register them.",
    );
    reportDryRunUndiscoveredSkillPlan(args, context);
    return 0;
  }

  const versionSuffix =
    existingPackage.resolvedVersion === undefined ? "" : `@${existingPackage.resolvedVersion}`;
  context.io.writeLine(
    `Would reuse installed ${existingPackage.packageName}${versionSuffix} in ${scope} scope.`,
  );
  context.io.writeLine("Workflow discovery: reading existing installed package.");

  const registrationPlan = await buildAddRegistrationPlan({
    args,
    scope,
    preparedSource: {
      status: "ready",
      source: existingPackage.packageName,
      cwd: existingPackage.installRoot,
      installedPackage: existingPackage,
    },
    context,
  });
  if (registrationPlan.status === "cancelled") {
    context.io.writeLine("Dry run: canceled.");
    return 0;
  }

  reportDryRunRegistrationPlan(registrationPlan, scope, context);
  return 0;
}

function reportDryRunUndiscoveredSkillPlan(args: AddCommandArgs, context: CliCommandContext): void {
  if (!args.projectSkill && !args.userSkill) {
    return;
  }

  context.io.writeLine(
    "Skills: requested skill writes/distribution would be planned after workflows are discovered; no skill files or distribution commands were run.",
  );
}

function reportDryRunRegistrationPlan(
  registrationPlan: Extract<AddRegistrationPlan, { readonly status: "ready" }>,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): void {
  if (registrationPlan.successfulRegistrations.length === 0) {
    context.io.writeLine("Dry run: no registrations would be written.");
  }

  for (const registration of registrationPlan.successfulRegistrations) {
    context.io.writeLine(
      `Would register ${registrationPlan.namespace}/${registration.name} -> ${registration.registryTarget.targetRef} in ${scope} config.`,
    );
  }

  if (registrationPlan.resolvedArgs.projectSkill || registrationPlan.resolvedArgs.userSkill) {
    for (const registration of registrationPlan.successfulRegistrations) {
      const skillName = workflowSkillName(registrationPlan.namespace, registration.name);
      context.io.writeLine(
        `Would write workflow skill ${skillName} for ${registrationPlan.namespace}/${registration.name}.`,
      );
      if (registrationPlan.resolvedArgs.projectSkill) {
        context.io.writeLine(`Would distribute workflow skill ${skillName} to project skills.`);
      }
      if (registrationPlan.resolvedArgs.userSkill) {
        context.io.writeLine(`Would distribute workflow skill ${skillName} to user skills.`);
      }
    }
  }

  if (
    registrationPlan.registrations.length > 1 ||
    registrationPlan.skippedConflicts > 0 ||
    registrationPlan.registrationConflicts.length > 0
  ) {
    context.io.writeLine(
      `Dry run summary: would register ${registrationPlan.successfulRegistrations.length}, skipped conflicts ${registrationPlan.skippedConflicts}.`,
    );
  }
}

type AddRegistrationPlan =
  | {
      readonly status: "ready";
      readonly namespace: string;
      readonly registrations: readonly AddRegistration[];
      readonly registrationConflicts: readonly RegistrationConflict[];
      readonly successfulRegistrations: readonly AddRegistration[];
      readonly skippedConflicts: number;
      readonly resolvedArgs: ResolvedSkillArgs;
    }
  | { readonly status: "cancelled" };

interface BuildAddRegistrationPlanOptions {
  readonly args: AddCommandArgs;
  readonly scope: WorkflowRegistryScope;
  readonly preparedSource: Extract<PreparedAddSource, { readonly status: "ready" }>;
  readonly context: CliCommandContext;
}

async function buildAddRegistrationPlan({
  args,
  scope,
  preparedSource,
  context,
}: BuildAddRegistrationPlanOptions): Promise<AddRegistrationPlan> {
  const registryTargets = attachPackageMetadataToRegistryTargets(
    await validateAndBuildRegistryTargets(
      {
        source: preparedSource.source,
        workflow: args.workflow,
        selectionPolicy: args.yes ? "all" : "prompt",
      },
      preparedSource.cwd,
      context,
    ),
    preparedSource.installedPackage,
  );

  if (registryTargets.length === 0) {
    context.io.writeLine("Canceled.");
    return { status: "cancelled" };
  }

  if (args.name !== undefined && registryTargets.length > 1) {
    throw new CliUsageError("trailstep add --name can only be used when registering one workflow.");
  }

  const namespace = await resolveNamespace(args.namespace, scope, context.prompts, {
    headless: args.yes,
  });
  assertNamespaceMatchesScope(namespace, scope);

  const registrations = registryTargets.map((registryTarget) => ({
    registryTarget,
    name: args.name ?? deriveDefaultWorkflowName(registryTarget.workflow),
  }));

  const registrationConflicts = await findRegistrationConflicts(
    namespace,
    registrations,
    scope,
    context,
  );
  const conflictResolution = await resolveRegistrationConflictActions({
    conflicts: registrationConflicts,
    force: args.force,
    headless: args.yes,
    context,
  });
  if (conflictResolution.status === "cancelled") {
    context.io.writeLine("Canceled.");
    return { status: "cancelled" };
  }
  const conflictActionByRegistrationName = new Map(
    conflictResolution.actions.map((entry) => [
      entry.conflict.registration.name,
      {
        action: entry.action,
        existingScope: entry.conflict.existingScope,
      },
    ]),
  );

  const successfulRegistrations: AddRegistration[] = [];
  let skippedConflicts = 0;
  for (const registration of registrations) {
    const conflictAction = conflictActionByRegistrationName.get(registration.name);
    if (conflictAction?.action === "skip") {
      skippedConflicts += 1;
      context.io.writeError(
        `Warning: skipped ${namespace}/${registration.name} because it already exists in ${conflictAction.existingScope} config. Use --force to replace it.`,
      );
      continue;
    }
    successfulRegistrations.push(registration);
  }

  const resolvedArgs =
    successfulRegistrations.length === 0
      ? { projectSkill: false, userSkill: false }
      : args.dryRun
        ? { projectSkill: args.projectSkill, userSkill: args.userSkill }
        : await resolveSkillArgs(args, context.prompts);

  return {
    status: "ready",
    namespace,
    registrations,
    registrationConflicts,
    successfulRegistrations,
    skippedConflicts,
    resolvedArgs,
  };
}

async function reportPackageAddInstallCleanup(
  preparedSource: Extract<PreparedAddSource, { readonly status: "ready" }>,
  context: CliCommandContext,
): Promise<void> {
  if (preparedSource.installedPackage === undefined) {
    return;
  }

  if (preparedSource.installSnapshot === undefined) {
    context.io.writeError(
      `Cleanup: preserved existing package ${preparedSource.installedPackage.packageName} in ${preparedSource.installedPackage.installScope} scope; no package install rollback was run.`,
    );
    return;
  }

  try {
    await rollbackWorkflowPackageInstall(preparedSource.installSnapshot);
    context.io.writeError(
      `Cleanup: rolled back package install for ${preparedSource.installedPackage.packageName} in ${preparedSource.installedPackage.installScope} scope.`,
    );
  } catch (cleanupError) {
    context.io.writeError(
      `Cleanup failed for package ${preparedSource.installedPackage.packageName} in ${preparedSource.installedPackage.installScope} scope: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`,
    );
  }
}

interface SplitAddSourceAndFlagArgsResult {
  readonly source?: string;
  readonly flagArgs: readonly string[];
}

function splitAddSourceAndFlagArgs(argv: readonly string[]): SplitAddSourceAndFlagArgsResult {
  let source: string | undefined;
  const flagArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (source === undefined && token.startsWith("--")) {
      flagArgs.push(token);
      if (isAddOptionWithValue(token)) {
        const value = argv[index + 1];
        if (value !== undefined) {
          flagArgs.push(value);
          index += 1;
        }
      }
      continue;
    }

    if (source === undefined) {
      source = token;
      continue;
    }

    flagArgs.push(token);
  }

  return source === undefined ? { flagArgs } : { source, flagArgs };
}

function isAddOptionWithValue(option: string): boolean {
  return (
    option === "--scope" ||
    option === "--namespace" ||
    option === "--name" ||
    option === "--workflow"
  );
}

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--force") {
      flags.force = "true";
      continue;
    }

    if (option === "--yes") {
      flags.yes = "true";
      continue;
    }

    if (option === "--dry-run") {
      flags["dry-run"] = "true";
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
      throw new CliUsageError(`Unknown option for trailstep add: ${option ?? ""}`);
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

interface RegistrationConflict {
  readonly namespace: string;
  readonly registration: AddRegistration;
  readonly existingScope: WorkflowRegistryScope;
}

async function findRegistrationConflicts(
  namespace: string,
  registrations: readonly AddRegistration[],
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): Promise<readonly RegistrationConflict[]> {
  const conflicts: RegistrationConflict[] = [];

  for (const registration of registrations) {
    const existingScope = await findExistingRegistrationScope(namespace, registration.name, scope, {
      cwd: context.cwd,
      homeDir: context.homeDir,
    });
    if (existingScope !== undefined) {
      conflicts.push({ namespace, registration, existingScope });
    }
  }

  return conflicts;
}

function formatHeadlessRegistrationConflictError(
  conflicts: readonly RegistrationConflict[],
): string {
  const entries = conflicts.map(
    (conflict) =>
      `${conflict.namespace}/${conflict.registration.name} already exists in ${conflict.existingScope} config`,
  );
  const prefix = conflicts.length === 1 ? "Registration conflict" : "Registration conflicts";
  return `${prefix}: ${entries.join("; ")}. Use --force to replace existing registrations or remove the conflicts first.`;
}

type RegistrationConflictAction = "replace" | "skip";

interface ResolvedRegistrationConflictAction {
  readonly conflict: RegistrationConflict;
  readonly action: RegistrationConflictAction;
}

type ResolveRegistrationConflictActionsResult =
  | {
      readonly status: "ready";
      readonly actions: readonly ResolvedRegistrationConflictAction[];
    }
  | { readonly status: "cancelled" };

interface ResolveRegistrationConflictActionsOptions {
  readonly conflicts: readonly RegistrationConflict[];
  readonly force: boolean;
  readonly headless: boolean;
  readonly context: CliCommandContext;
}

async function resolveRegistrationConflictActions({
  conflicts,
  force,
  headless,
  context,
}: ResolveRegistrationConflictActionsOptions): Promise<ResolveRegistrationConflictActionsResult> {
  if (conflicts.length === 0) {
    return { status: "ready", actions: [] };
  }
  if (force) {
    return {
      status: "ready",
      actions: conflicts.map((conflict) => ({ conflict, action: "replace" })),
    };
  }
  if (headless) {
    throw new CliUsageError(formatHeadlessRegistrationConflictError(conflicts));
  }
  if (context.prompts === undefined) {
    return {
      status: "ready",
      actions: conflicts.map((conflict) => ({ conflict, action: "skip" })),
    };
  }

  const actions: ResolvedRegistrationConflictAction[] = [];
  for (const conflict of conflicts) {
    const decision = await promptSelect(
      registrationConflictPrompt(conflict),
      REGISTRATION_CONFLICT_PROMPT_CHOICES,
      context.prompts,
      `${conflict.namespace}/${conflict.registration.name} already exists in ${conflict.existingScope} config. Run interactively to choose replace, skip, or cancel.`,
    );
    if (decision === "Cancel add") {
      return { status: "cancelled" };
    }
    actions.push({
      conflict,
      action: decision === "Replace existing registration" ? "replace" : "skip",
    });
  }

  return { status: "ready", actions };
}

function registrationConflictPrompt(conflict: RegistrationConflict): string {
  return `${conflict.namespace}/${conflict.registration.name} already exists in ${conflict.existingScope} config. What should TrailStep do?`;
}

async function resolveNamespace(
  explicitNamespace: string | undefined,
  scope: WorkflowRegistryScope,
  prompts: CliCommandContext["prompts"],
  options: { readonly headless: boolean } = { headless: false },
): Promise<string> {
  if (explicitNamespace !== undefined) {
    return explicitNamespace;
  }
  if (scope !== "global") {
    return "project";
  }
  if (options.headless || prompts === undefined) {
    return "global";
  }

  const wantsNamespace = await promptYesNo(
    "Add a namespace to avoid collisions?",
    prompts,
    "trailstep add requires --namespace <namespace> when scope is global and not run interactively.",
  );
  if (!wantsNamespace) {
    return "global";
  }
  return promptText(
    "Namespace",
    undefined,
    prompts,
    "trailstep add requires --namespace <namespace>.",
  );
}

function deriveDefaultWorkflowName(workflow: WorkflowSkillMetadata | undefined): string {
  const id = workflow?.id;
  if (id === undefined) {
    throw new CliUsageError("trailstep add requires --name <name> for this source.");
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
    !args.yes && prompts !== undefined && !args.projectSkillExplicit && !args.userSkillExplicit;

  if (!promptSkillChoices) {
    return { projectSkill: args.projectSkill, userSkill: args.userSkill };
  }

  return {
    projectSkill: await promptYesNo(
      "Add to project skills?",
      prompts,
      "trailstep add requires --project-skill.",
    ),
    userSkill: await promptYesNo(
      "Add to user skills?",
      prompts,
      "trailstep add requires --user-skill.",
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

  const loadedConfig = await loadTrailStepProjectConfig(context.cwd, { homeDir: context.homeDir });
  const effectiveConfig = loadedConfig.trailstepConfig;
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
  effectiveConfig: TrailStepConfig,
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
  config: TrailStepConfig,
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
    cwd: context.cwd,
    io: context.io,
    packageCommandRunner: context.packageCommandRunner,
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
    const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
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
  const config = await readRawTrailStepConfigFile(configPath);
  const agents = toMutableRecord(config.agents);
  agents[name] = entry;
  if (customProvider === undefined) {
    await writeRawTrailStepConfigFile(configPath, { ...config, agents });
    return;
  }
  const customProviders = toMutableRecord(config.customProviders);
  customProviders[customProvider.name] = { ...customProvider.config };
  await writeRawTrailStepConfigFile(configPath, { ...config, customProviders, agents });
}

async function writeWorkflowRoleMapping(
  scope: WorkflowRegistryScope,
  workflowId: string,
  roleName: string,
  entry: readonly Record<string, unknown>[],
  context: CliCommandContext,
): Promise<void> {
  const configPath = configPathForScope(scope, context);
  const config = await readRawTrailStepConfigFile(configPath);
  const workflows = toMutableRecord(config.workflows);
  const workflowConfig = toMutableRecord(workflows[workflowId]);
  const workflowAgents = toMutableRecord(workflowConfig.agents);
  workflowAgents[roleName] = entry;
  workflows[workflowId] = { ...workflowConfig, agents: workflowAgents };
  await writeRawTrailStepConfigFile(configPath, { ...config, workflows });
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
    warnings += await tryDistributeWorkflowSkill(
      args,
      writtenSkill.skillDirectory,
      "project",
      context,
    );
  }
  if (args.userSkill) {
    warnings += await tryDistributeWorkflowSkill(
      args,
      writtenSkill.skillDirectory,
      "user",
      context,
    );
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
  readonly bundleExportName?: string;
  readonly metadata?: WorkflowPackageRegistryMetadata;
}

interface AddWorkflowCandidate extends AddRegistryTarget {
  readonly selectionName: string;
  readonly sourceKind: "bundle" | "direct";
}

type AddWorkflowSelectionPolicy = "prompt" | "all";

interface SourceResolutionArgs {
  readonly source: string;
  readonly workflow?: string;
  readonly selectionPolicy: AddWorkflowSelectionPolicy;
}

type PreparedAddSource =
  | {
      readonly status: "ready";
      readonly source: string;
      readonly cwd: string;
      readonly installedPackage?: InstalledNpmWorkflowPackage;
      readonly installSnapshot?: WorkflowPackageInstallSnapshot;
    }
  | { readonly status: "cancelled" };

interface PrepareAddSourceOptions {
  readonly headless: boolean;
}

async function prepareAddSource(
  source: string,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
  options: PrepareAddSourceOptions,
): Promise<PreparedAddSource> {
  const packageRef = parseWorkflowPackageRef(source);
  if (packageRef === undefined) {
    return { status: "ready", source, cwd: context.cwd };
  }

  const availablePackage = await ensureNpmWorkflowPackageAvailable({
    packageRef,
    scope,
    context,
    headless: options.headless,
  });
  if (availablePackage.installAction === "cancel") {
    context.io.writeLine("Canceled.");
    return { status: "cancelled" };
  }
  if (availablePackage.installAction === "install") {
    context.io.writeLine(`Installed ${packageRef.requestedSpec} in ${scope} scope.`);
  } else {
    context.io.writeLine(`Using installed ${availablePackage.packageName} in ${scope} scope.`);
  }
  return {
    status: "ready",
    source: availablePackage.installedPackage.packageName,
    cwd: availablePackage.installedPackage.installRoot,
    installedPackage: availablePackage.installedPackage,
    ...(availablePackage.installSnapshot === undefined
      ? {}
      : { installSnapshot: availablePackage.installSnapshot }),
  };
}

type EnsurePackageInstallAction = "reuse" | "install" | "cancel";

interface EnsureNpmWorkflowPackageAvailableOptions {
  readonly packageRef: ParsedWorkflowPackageRef;
  readonly scope: WorkflowRegistryScope;
  readonly context: CliCommandContext;
  readonly headless: boolean;
}

type EnsureNpmWorkflowPackageAvailableResult =
  | {
      readonly installAction: Exclude<EnsurePackageInstallAction, "cancel">;
      readonly installRoot: string;
      readonly packageName: string;
      readonly installedPackage: InstalledNpmWorkflowPackage;
      readonly resolvedVersion?: string;
      readonly installSnapshot?: WorkflowPackageInstallSnapshot;
    }
  | {
      readonly installAction: "cancel";
      readonly installRoot: string;
      readonly packageName: string;
      readonly resolvedVersion?: string;
    };

async function ensureNpmWorkflowPackageAvailable({
  packageRef,
  scope,
  context,
  headless,
}: EnsureNpmWorkflowPackageAvailableOptions): Promise<EnsureNpmWorkflowPackageAvailableResult> {
  const installRoot = workflowPackageInstallRootForScope(scope, context);
  const existingPackage = await readExistingInstalledNpmWorkflowPackage(
    packageRef,
    scope,
    installRoot,
  );

  if (existingPackage !== undefined) {
    if (headless) {
      return ensurePackageAvailableResult("reuse", existingPackage);
    }

    writeExistingPackageSummary(existingPackage, packageRef, scope, context);
    const action = await promptSelect(
      existingPackagePrompt(existingPackage.packageName, scope),
      EXISTING_PACKAGE_PROMPT_CHOICES,
      context.prompts,
      `Package ${existingPackage.packageName} is already installed in ${scope} scope. Run interactively to choose reuse, reinstall/upgrade, or cancel.`,
    );
    if (action === "Cancel") {
      return {
        installAction: "cancel",
        installRoot,
        packageName: existingPackage.packageName,
        ...(existingPackage.resolvedVersion === undefined
          ? {}
          : { resolvedVersion: existingPackage.resolvedVersion }),
      };
    }
    if (action === "Reuse installed package") {
      return ensurePackageAvailableResult("reuse", existingPackage);
    }
  }

  const installSnapshot = await createWorkflowPackageInstallSnapshot({
    installRoot,
    ...(packageRef.sourceType === "npm" ? { packageName: packageRef.packageName } : {}),
  });
  return ensurePackageAvailableResult(
    "install",
    await installNpmWorkflowPackage({
      packageRef,
      scope,
      cwd: context.cwd,
      homeDir: context.homeDir,
      packageCommandRunner: context.packageCommandRunner,
    }),
    installSnapshot,
  );
}

function ensurePackageAvailableResult(
  installAction: "reuse" | "install",
  installedPackage: InstalledNpmWorkflowPackage,
  installSnapshot?: WorkflowPackageInstallSnapshot,
): EnsureNpmWorkflowPackageAvailableResult {
  return {
    installAction,
    installRoot: installedPackage.installRoot,
    packageName: installedPackage.packageName,
    installedPackage,
    ...(installedPackage.resolvedVersion === undefined
      ? {}
      : { resolvedVersion: installedPackage.resolvedVersion }),
    ...(installSnapshot === undefined ? {} : { installSnapshot }),
  };
}

async function readExistingInstalledNpmWorkflowPackage(
  packageRef: ParsedWorkflowPackageRef,
  scope: WorkflowRegistryScope,
  installRoot: string,
): Promise<InstalledNpmWorkflowPackage | undefined> {
  if (packageRef.sourceType !== "npm") {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(
        join(installRoot, "node_modules", ...packageRef.packageName.split("/"), "package.json"),
        "utf8",
      ),
    ) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const manifest = isRecord(parsed) ? parsed : {};
  const manifestPackageName = manifest.name;
  const packageName =
    typeof manifestPackageName === "string" && manifestPackageName.trim().length > 0
      ? manifestPackageName
      : packageRef.packageName;
  const resolvedVersion = manifest.version;
  return {
    sourceType: "npm",
    packageName,
    requestedSpec: packageRef.requestedSpec,
    requestedRange: packageRef.requestedRange,
    installScope: scope,
    installRoot,
    ...(typeof resolvedVersion === "string" ? { resolvedVersion } : {}),
    installOwnership: "reused-existing",
  };
}

function writeExistingPackageSummary(
  installedPackage: InstalledNpmWorkflowPackage,
  packageRef: ParsedWorkflowPackageRef,
  scope: WorkflowRegistryScope,
  context: CliCommandContext,
): void {
  const versionSuffix =
    installedPackage.resolvedVersion === undefined ? "" : `@${installedPackage.resolvedVersion}`;
  context.io.writeLine(
    `Package ${installedPackage.packageName}${versionSuffix} is already installed in ${scope} scope.`,
  );
  context.io.writeLine(`Source type: ${installedPackage.sourceType}`);
  context.io.writeLine(`Requested spec: ${packageRef.requestedSpec}`);
  context.io.writeLine(`Install root: ${installedPackage.installRoot}`);
}

function existingPackagePrompt(packageName: string, scope: WorkflowRegistryScope): string {
  return `Package ${packageName} is already installed in ${scope} scope. What should TrailStep do?`;
}

function attachPackageMetadataToRegistryTargets(
  targets: readonly AddRegistryTarget[],
  installedPackage: InstalledNpmWorkflowPackage | undefined,
): readonly AddRegistryTarget[] {
  if (installedPackage === undefined) {
    return targets;
  }

  return targets.map((target) => ({
    ...target,
    metadata: createPackageRegistryMetadata(target, installedPackage),
  }));
}

function createPackageRegistryMetadata(
  target: AddRegistryTarget,
  installedPackage: InstalledNpmWorkflowPackage,
): WorkflowPackageRegistryMetadata {
  const workflowName = target.bundleSpecifier?.workflowName ?? target.workflow?.id;
  if (workflowName === undefined) {
    throw new WorkflowResolutionError(
      `Unable to determine package workflow metadata for ${target.targetRef}.`,
    );
  }

  return {
    kind: "package",
    sourceType: installedPackage.sourceType,
    packageName: installedPackage.packageName,
    requestedSpec: installedPackage.requestedSpec,
    requestedRange: installedPackage.requestedRange,
    installScope: installedPackage.installScope,
    targetRef: target.targetRef,
    workflowName,
    exportName: target.bundleExportName ?? workflowName,
    ...(installedPackage.resolvedVersion === undefined
      ? {}
      : { resolvedVersion: installedPackage.resolvedVersion }),
    ...(installedPackage.githubRef === undefined ? {} : { githubRef: installedPackage.githubRef }),
    ...(installedPackage.installOwnership === undefined
      ? {}
      : { installOwnership: installedPackage.installOwnership }),
  };
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
  const candidates = (await isBundleSource(source, cwd))
    ? await listBundleAddWorkflowCandidates(source, cwd)
    : await listDirectAddWorkflowCandidates(source, cwd);

  if (candidates.length === 0) {
    throw new WorkflowResolutionError(`No workflows found in ${source}.`);
  }

  return candidates;
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
      bundleExportName: bundleWorkflow.workflowRef.exportName,
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

  if (args.selectionPolicy === "all") {
    return candidates;
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
    throw new CliUsageError("trailstep add --workflow entries must be non-empty workflow names.");
  }
  const selectedNameSet = new Set(selectedNames);
  if (selectedNameSet.size !== selectedNames.length) {
    throw new CliUsageError("trailstep add --workflow entries must not contain duplicates.");
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
    const trailstep = isRecord(parsed) ? parsed.trailstep : undefined;
    return isRecord(trailstep) && isRecord(trailstep.workflows);
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

function isNodeError(error: unknown): error is { readonly code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
