import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import type { RawTrailStepAgentMappings, RawTrailStepAgentTarget } from "./parse-agent-targets.js";
import type { RawTrailStepWorkflowConfig } from "./parse-workflow-agent-mappings.js";

export function validateProviderReferences(options: {
  readonly agents: RawTrailStepAgentMappings;
  readonly workflows: Readonly<Record<string, RawTrailStepWorkflowConfig>> | undefined;
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
    throw new TrailStepFailureError({
      code: "agent_provider_unknown",
      message:
        "One or more agent targets reference a provider that is not declared under customProviders/providers.",
      details: { diagnostics: providerViolations },
    });
  }
}

function validateAgentMappings(
  path: string,
  mappings: RawTrailStepAgentMappings | undefined,
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
  targets: readonly RawTrailStepAgentTarget[],
  providerNames: Set<string>,
  diagnostics: string[],
): void {
  for (const [index, target] of targets.entries()) {
    if (!("provider" in target)) {
      continue;
    }

    if (!providerNames.has(target.provider)) {
      diagnostics.push(
        `${path}[${index}].provider references unknown provider '${target.provider}'. Declare it under customProviders/providers.`,
      );
    }
  }
}
