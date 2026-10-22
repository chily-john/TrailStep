import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { workflowPackageInstallRootForScope } from "../../workflow-packages/install-root.js";
import { parseWorkflowPackageRef } from "../../workflow-packages/package-ref.js";
import type { WorkflowRegistryScope } from "../../workflow-registry/workflow-registry.js";

import type { AddCommandArgs, AddRegistrationPlan } from "./add-command.types.js";
import {
  buildRecommendedConfigPlanForPreparedSource,
  reportDryRunRecommendedConfigPlan,
} from "./add-config-writes.js";
import { buildAddRegistrationPlan } from "./add-registration-plan.js";
import { readExistingInstalledNpmWorkflowPackage } from "./add-source-resolution.js";

export async function runPackageAddDryRun(
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
  await reportDryRunRecommendedConfigPlan(
    await buildRecommendedConfigPlanForPreparedSource(
      {
        status: "ready",
        source: existingPackage.packageName,
        cwd: existingPackage.installRoot,
        installedPackage: existingPackage,
      },
      scope,
      context,
    ),
    scope,
    context,
  );
  return 0;
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
