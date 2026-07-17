import type { StepKitConfig } from "../targeting.types.js";
import { parseCustomAgents } from "./parse-custom-agents.js";
import { parseSizeAgentMappings } from "./parse-size-agent-mappings.js";
import { isRecord, throwValidationFailure } from "./parse-utils.js";
import { parseWorkflows } from "./parse-workflow-agent-mappings.js";
import { validateProviderReferences } from "./validate-provider-references.js";

export function parseStepKitConfig(value: unknown): StepKitConfig {
  const diagnostics: string[] = [];

  if (!isRecord(value)) {
    throwValidationFailure(["config must be an object."]);
  }

  if (value.version !== 1) {
    diagnostics.push("version must be 1.");
  }

  const customAgents = parseCustomAgents(value.customAgents, diagnostics);
  const providerNames = new Set(Object.keys(customAgents));
  const workingAgents = parseSizeAgentMappings("workingAgents", value.workingAgents, diagnostics);
  const interactiveAgents = parseSizeAgentMappings(
    "interactiveAgents",
    value.interactiveAgents,
    diagnostics,
  );
  const workflows = parseWorkflows(value.workflows, diagnostics);

  if (diagnostics.length > 0) {
    throwValidationFailure(diagnostics);
  }

  validateProviderReferences({ workingAgents, interactiveAgents, workflows, providerNames });

  return {
    version: 1,
    customAgents,
    workingAgents,
    interactiveAgents,
    ...(workflows === undefined ? {} : { workflows }),
  };
}
