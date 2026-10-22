import type { CliCommandContext } from "../../command-framework/command.types.js";
import {
  configPathForScope,
  readRawTrailStepConfigFile,
} from "../../workflow-registry/workflow-registry.js";

import { resolveScope } from "./providers-args.js";
import { resolveProviderBinary } from "./providers-binary.js";
import type { ProviderCommandArgs } from "./providers-command.types.js";
import { providerRegistrationHasHooks, writeProviderHookTrustWarning } from "./providers-config.js";
import { readRegistration, requiredEnvironmentVariables } from "./providers-registration.js";
import { toMutableRecord } from "./record-utils.js";

export async function testProvider(
  args: Extract<ProviderCommandArgs, { readonly action: "test" }>,
  context: CliCommandContext,
): Promise<number> {
  const scope = await resolveScope(args.scope, context);
  const config = await readRawTrailStepConfigFile(configPathForScope(scope, context));
  const rawRegistration = toMutableRecord(config.providers)[args.provider];
  const diagnostics: string[] = [];
  const registration = readRegistration(rawRegistration, diagnostics);
  let failed = false;

  if (registration === undefined) {
    context.io.writeError(
      diagnostics.length > 0
        ? `Invalid stored provider metadata for ${args.provider}:\n${diagnostics.join("\n")}`
        : `Provider ${args.provider} does not exist in ${scope} config.`,
    );
    return 1;
  }

  context.io.writeLine(`Provider: ${registration.manifest.id}`);
  context.io.writeLine("Registration: valid");

  if (registration.manifest.working.supported) {
    const command = registration.manifest.working.command;
    if (command === undefined || !(await resolveProviderBinary(command, context))) {
      context.io.writeError(`Missing binary for working.command: ${command ?? "(missing)"}`);
      failed = true;
    } else {
      context.io.writeLine(`Working binary: ${command}`);
    }
  }

  if (registration.manifest.interactive.command !== undefined) {
    const command = registration.manifest.interactive.command;
    if (!(await resolveProviderBinary(command, context))) {
      context.io.writeError(`Missing binary for interactive.command: ${command}`);
      failed = true;
    } else {
      context.io.writeLine(`Interactive binary: ${command}`);
    }
  }

  for (const variable of requiredEnvironmentVariables(registration.manifest)) {
    const value = context.env?.[variable];
    if (value === undefined || value === "") {
      context.io.writeError(`Missing required environment variable: ${variable}`);
      failed = true;
    } else {
      context.io.writeLine(`Required environment variable present: ${variable}`);
    }
  }

  const hooksPresent = await providerRegistrationHasHooks(rawRegistration, scope, context);
  context.io.writeLine(`Hooks: ${hooksPresent ? "present" : "absent"}`);
  writeProviderHookTrustWarning(context, hooksPresent);
  context.io.writeLine("Prompt execution skipped.");
  return failed ? 1 : 0;
}
