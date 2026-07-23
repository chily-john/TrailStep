import { StepKitFailureError } from "../../contracts/failures/failure.js";
import { isProviderRegistryKey } from "../../known-cli-providers/registry/provider-registry.js";
import type { RawStepKitAgentMappings, RawStepKitAgentTarget } from "./parse-agent-targets.js";
import type { RawStepKitWorkflowConfig } from "./parse-workflow-agent-mappings.js";

export function validateProviderReferences(options: {
  readonly agents: RawStepKitAgentMappings;
  readonly workflows: Readonly<Record<string, RawStepKitWorkflowConfig>> | undefined;
  readonly providerNames: Set<string>;
}): void {
  const providerViolations: string[] = [];

  validateAgentMappings("agents", options.agents, options.providerNames, providerViolations);

  if (options.workflows !== undefined) {
    for (const [workflowId, workflow] of Object.entries(options.workflows)) {
      validateAgentMappings(
        `workflows.${workflowId}.agents`,
        workflow.agents,
        options.providerNames,
        providerViolations,
      );
    }
  }

  if (providerViolations.length > 0) {
    throw new StepKitFailureError({
      code: "agent_provider_unknown",
      message:
        "One or more agent targets reference a provider that is neither a built-in provider nor a declared customProviders entry.",
      details: { diagnostics: providerViolations },
    });
  }
}

function validateAgentMappings(
  path: string,
  mappings: RawStepKitAgentMappings | undefined,
  providerNames: Set<string>,
  diagnostics: string[],
): void {
  if (mappings === undefined) {
    return;
  }

  for (const [name, targets] of Object.entries(mappings)) {
    validateTargetReferences(`${path}.${name}`, targets, providerNames, diagnostics);
  }
}

function validateTargetReferences(
  path: string,
  targets: readonly RawStepKitAgentTarget[],
  providerNames: Set<string>,
  diagnostics: string[],
): void {
  for (const [index, target] of targets.entries()) {
    if (!("provider" in target)) {
      continue;
    }

    if (!providerNames.has(target.provider) && !isProviderRegistryKey(target.provider)) {
      diagnostics.push(
        `${path}[${index}].provider references unknown provider '${target.provider}'. Declare it under customProviders or use a built-in provider.`,
      );
    }
  }
}
