import type { CliCommand, CliCommandContext } from "../../command-framework/command.types.js";
import { offerMcpRegistration } from "../../mcp-tools/mcp-registration.js";
import { promptSelect } from "../../prompts/prompt-helpers.js";
import { WorkflowPackageInstallError } from "../../workflow-packages/npm-package-installer.js";
import { writeWorkflowRegistryEntries } from "../../workflow-registry/workflow-registry.js";
import { promptForUncoveredWorkflowRolesForRegistrations } from "./add-agent-setup.js";
import { parseAddCommandArgs } from "./add-args.js";
import type {
  AddCommandArgs,
  AddRegistrationPlan,
  PreparedAddSource,
} from "./add-command.types.js";
import { applyRecommendedConfigForPreparedSource } from "./add-config-writes.js";
import { runPackageAddDryRun } from "./add-dry-run.js";
import { generateMcpToolJsonForRegistration } from "./add-mcp-registration.js";
import { buildAddRegistrationPlan } from "./add-registration-plan.js";
import { prepareAddSource, reportPackageAddInstallCleanup } from "./add-source-resolution.js";

const SCOPE_PROMPT_LABEL =
  "Where should this workflow be registered? (local = just you on this repo, " +
  "project = shared with your team, global = global across all your projects)";

export const addCommand: CliCommand<AddCommandArgs> = {
  name: "add",
  parseArgs(argv: readonly string[]): AddCommandArgs {
    return parseAddCommandArgs(argv);
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

    for (const registration of successfulRegistrations) {
      await generateMcpToolJsonForRegistration(namespace, registration, context.cwd, context);
    }

    if (successfulRegistrations.length > 0) {
      await applyRecommendedConfigForPreparedSource(preparedSource, scope, context);
    }

    if (!args.yes) {
      await promptForUncoveredWorkflowRolesForRegistrations(
        { scope, registrations: successfulRegistrations },
        context,
      );
    }

    if (registrations.length > 1 || skippedConflicts > 0 || registrationConflicts.length > 0) {
      context.io.writeLine(
        `Summary: registered ${successfulRegistrations.length}, skipped conflicts ${skippedConflicts}.`,
      );
    }

    await offerMcpRegistration({
      projectDir: context.cwd,
      io: context.io,
      assumeYes: args.yes,
      scope,
      ...(context.prompts === undefined ? {} : { prompts: context.prompts }),
      ...(context.env === undefined ? {} : { env: context.env }),
      ...(context.homeDir === undefined ? {} : { homeDir: context.homeDir }),
    });

    return 0;
  },
};
