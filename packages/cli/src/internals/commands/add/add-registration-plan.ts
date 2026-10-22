import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { promptSelect, promptText, promptYesNo } from "../../prompts/prompt-helpers.js";
import {
  assertNamespaceMatchesScope,
  findExistingRegistrationScope,
  type WorkflowRegistryScope,
} from "../../workflow-registry/workflow-registry.js";
import { isDirectWorkflowFileReference } from "../../workflow-resolution/workflow-resolution.js";

import type {
  AddCommandArgs,
  AddRegistration,
  AddRegistrationPlan,
  AddRegistryTarget,
  PreparedAddSource,
  RegistrationConflict,
} from "./add-command.types.js";
import {
  attachPackageMetadataToRegistryTargets,
  validateAndBuildRegistryTargets,
} from "./add-source-resolution.js";

const REGISTRATION_CONFLICT_PROMPT_CHOICES = [
  "Replace existing registration",
  "Skip this workflow",
  "Cancel add",
] as const;

interface BuildAddRegistrationPlanOptions {
  readonly args: AddCommandArgs;
  readonly scope: WorkflowRegistryScope;
  readonly preparedSource: Extract<PreparedAddSource, { readonly status: "ready" }>;
  readonly context: CliCommandContext;
}

export async function buildAddRegistrationPlan({
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
    name: args.name ?? deriveDefaultWorkflowName(registryTarget),
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

  return {
    status: "ready",
    namespace,
    registrations,
    registrationConflicts,
    successfulRegistrations,
    skippedConflicts,
  };
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

function deriveDefaultWorkflowName(registryTarget: AddRegistryTarget): string {
  const id = registryTarget.workflow?.id ?? registryTarget.bundleSpecifier?.workflowName;
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
