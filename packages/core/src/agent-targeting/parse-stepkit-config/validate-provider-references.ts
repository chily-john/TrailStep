import { StepKitFailureError } from "../../contracts/failures/failure.js";
import { isProviderRegistryKey } from "../../known-cli-providers/registry/provider-registry.js";
import type {
  StepKitAgentTarget,
  StepKitRoleAgentMappings,
  StepKitSizeAgentMappings,
  StepKitWorkflowConfig,
} from "../targeting.types.js";

export function validateProviderReferences(options: {
  readonly workingAgents: StepKitSizeAgentMappings;
  readonly interactiveAgents: StepKitSizeAgentMappings;
  readonly workflows: Readonly<Record<string, StepKitWorkflowConfig>> | undefined;
  readonly providerNames: Set<string>;
}): void {
  const providerViolations: string[] = [];

  validateSizeTargetReferences(
    "workingAgents",
    options.workingAgents,
    options.providerNames,
    providerViolations,
  );
  validateSizeTargetReferences(
    "interactiveAgents",
    options.interactiveAgents,
    options.providerNames,
    providerViolations,
  );

  if (options.workflows !== undefined) {
    for (const [workflowId, workflow] of Object.entries(options.workflows)) {
      validateRoleTargetReferences(
        `workflows.${workflowId}.workingAgents`,
        workflow.workingAgents,
        options.providerNames,
        providerViolations,
      );
      validateRoleTargetReferences(
        `workflows.${workflowId}.interactiveAgents`,
        workflow.interactiveAgents,
        options.providerNames,
        providerViolations,
      );
    }
  }

  if (providerViolations.length > 0) {
    throw new StepKitFailureError({
      code: "agent_provider_unknown",
      message:
        "One or more agent targets reference a provider that is neither a built-in provider nor a declared customAgents entry.",
      details: { diagnostics: providerViolations },
    });
  }
}

function validateSizeTargetReferences(
  path: string,
  mappings: StepKitSizeAgentMappings,
  providerNames: Set<string>,
  diagnostics: string[],
): void {
  for (const [size, targets] of Object.entries(mappings)) {
    validateTargetReferences(`${path}.${size}`, targets, providerNames, diagnostics);
  }
}

function validateRoleTargetReferences(
  path: string,
  mappings: StepKitRoleAgentMappings | undefined,
  providerNames: Set<string>,
  diagnostics: string[],
): void {
  if (mappings === undefined) {
    return;
  }

  for (const [roleName, targets] of Object.entries(mappings)) {
    validateTargetReferences(`${path}.${roleName}`, targets, providerNames, diagnostics);
  }
}

function validateTargetReferences(
  path: string,
  targets: readonly StepKitAgentTarget[],
  providerNames: Set<string>,
  diagnostics: string[],
): void {
  for (const [index, target] of targets.entries()) {
    if (!providerNames.has(target.provider) && !isProviderRegistryKey(target.provider)) {
      diagnostics.push(
        `${path}[${index}].provider references unknown provider '${target.provider}'. Declare it under customAgents or use a built-in provider.`,
      );
    }
  }
}
