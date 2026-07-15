import type { WorkflowAgentSize, WorkflowAgentThinking } from "../../shared/agent-role.types.js";
import { StepKitFailureError, validationFailure } from "../../shared/failure.js";
import { isProviderRegistryKey } from "../provider-adapter/provider-adapter.js";
import type {
  ResolveAgentTargetsOptions,
  StepKitAgentTarget,
  StepKitConfig,
  StepKitCustomAgentConfig,
  StepKitRoleAgentMappings,
  StepKitSizeAgentMappings,
  StepKitWorkflowConfig,
} from "./targeting.types.js";

const AGENT_SIZES = new Set<WorkflowAgentSize>([
  "default",
  "tiny",
  "small",
  "medium",
  "large",
  "xl",
]);

const THINKING_LEVELS = new Set<WorkflowAgentThinking>(["low", "medium", "high", "xhigh", "max"]);

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

  const providerViolations: string[] = [];
  validateSizeTargetReferences("workingAgents", workingAgents, providerNames, providerViolations);
  validateSizeTargetReferences(
    "interactiveAgents",
    interactiveAgents,
    providerNames,
    providerViolations,
  );
  if (workflows !== undefined) {
    for (const [workflowId, workflow] of Object.entries(workflows)) {
      validateRoleTargetReferences(
        `workflows.${workflowId}.workingAgents`,
        workflow.workingAgents,
        providerNames,
        providerViolations,
      );
      validateRoleTargetReferences(
        `workflows.${workflowId}.interactiveAgents`,
        workflow.interactiveAgents,
        providerNames,
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

  return {
    version: 1,
    customAgents,
    workingAgents,
    interactiveAgents,
    ...(workflows === undefined ? {} : { workflows }),
  };
}

export function resolveAgentTargets(
  options: ResolveAgentTargetsOptions,
): readonly StepKitAgentTarget[] {
  const modeMappings =
    options.mode === "working" ? options.config.workingAgents : options.config.interactiveAgents;
  const workflowMappings =
    options.config.workflows?.[options.workflowId]?.[`${options.mode}Agents`];

  const targetLists = [
    workflowMappings?.[options.roleName],
    modeMappings[options.roleSize],
    modeMappings.default,
  ];

  for (const targets of targetLists) {
    if (targets !== undefined && targets.length > 0) {
      return targets;
    }
  }

  throw new StepKitFailureError({
    code: "agent_targets_unavailable",
    message: `No ${options.mode} agent targets found for role ${options.roleName} with size ${options.roleSize} in workflow ${options.workflowId}.`,
    details: {
      mode: options.mode,
      roleName: options.roleName,
      roleSize: options.roleSize,
      workflowId: options.workflowId,
    },
  });
}

function parseCustomAgents(
  value: unknown,
  diagnostics: string[],
): Record<string, StepKitCustomAgentConfig> {
  const customAgents: Record<string, StepKitCustomAgentConfig> = {};

  if (!isRecord(value)) {
    diagnostics.push("customAgents must be an object.");
    return customAgents;
  }

  for (const [name, agentConfig] of Object.entries(value)) {
    if (!isRecord(agentConfig)) {
      diagnostics.push(`customAgents.${name} must be an object.`);
      continue;
    }

    if (typeof agentConfig.binary !== "string" || agentConfig.binary.length === 0) {
      diagnostics.push(`customAgents.${name}.binary must be a non-empty string.`);
      continue;
    }

    const args = parseOptionalStringArray(
      `customAgents.${name}.args`,
      agentConfig.args,
      diagnostics,
    );
    const env = parseOptionalStringRecord(`customAgents.${name}.env`, agentConfig.env, diagnostics);

    if (agentConfig.cwd !== undefined && typeof agentConfig.cwd !== "string") {
      diagnostics.push(`customAgents.${name}.cwd must be a string when present.`);
    }

    customAgents[name] = {
      binary: agentConfig.binary,
      ...(args === undefined ? {} : { args }),
      ...(typeof agentConfig.cwd === "string" ? { cwd: agentConfig.cwd } : {}),
      ...(env === undefined ? {} : { env }),
    };
  }

  return customAgents;
}

function parseSizeAgentMappings(
  path: string,
  value: unknown,
  diagnostics: string[],
): StepKitSizeAgentMappings {
  const mappings: Record<string, readonly StepKitAgentTarget[]> = {};

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return mappings;
  }

  for (const [size, targets] of Object.entries(value)) {
    if (!AGENT_SIZES.has(size as WorkflowAgentSize)) {
      diagnostics.push(
        `${path}.${size} must be one of default, tiny, small, medium, large, or xl.`,
      );
      continue;
    }

    mappings[size] = parseTargetArray(`${path}.${size}`, targets, diagnostics);
  }

  return mappings;
}

function parseRoleAgentMappings(
  path: string,
  value: unknown,
  diagnostics: string[],
): StepKitRoleAgentMappings | undefined {
  if (value === undefined) {
    return undefined;
  }

  const mappings: Record<string, readonly StepKitAgentTarget[]> = {};

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object.`);
    return mappings;
  }

  for (const [roleName, targets] of Object.entries(value)) {
    mappings[roleName] = parseTargetArray(`${path}.${roleName}`, targets, diagnostics);
  }

  return mappings;
}

function parseWorkflows(
  value: unknown,
  diagnostics: string[],
): Record<string, StepKitWorkflowConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const workflows: Record<string, StepKitWorkflowConfig> = {};

  if (!isRecord(value)) {
    diagnostics.push("workflows must be an object when present.");
    return workflows;
  }

  for (const [workflowId, workflow] of Object.entries(value)) {
    if (!isRecord(workflow)) {
      diagnostics.push(`workflows.${workflowId} must be an object.`);
      continue;
    }

    const workingAgents = parseRoleAgentMappings(
      `workflows.${workflowId}.workingAgents`,
      workflow.workingAgents,
      diagnostics,
    );
    const interactiveAgents = parseRoleAgentMappings(
      `workflows.${workflowId}.interactiveAgents`,
      workflow.interactiveAgents,
      diagnostics,
    );

    if (workflow.settings !== undefined && !isRecord(workflow.settings)) {
      diagnostics.push(`workflows.${workflowId}.settings must be an object when present.`);
    }

    workflows[workflowId] = {
      ...(workingAgents === undefined ? {} : { workingAgents }),
      ...(interactiveAgents === undefined ? {} : { interactiveAgents }),
      ...(isRecord(workflow.settings) ? { settings: workflow.settings } : {}),
    };
  }

  return workflows;
}

function parseTargetArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly StepKitAgentTarget[] {
  if (!Array.isArray(value)) {
    diagnostics.push(`${path} must be an array.`);
    return [];
  }

  return value.flatMap((target, index) => {
    const targetPath = `${path}[${index}]`;

    if (!isRecord(target)) {
      diagnostics.push(`${targetPath} must be an object.`);
      return [];
    }

    if (typeof target.provider !== "string" || target.provider.length === 0) {
      diagnostics.push(`${targetPath}.provider must be a non-empty string.`);
      return [];
    }

    if (target.model !== undefined && typeof target.model !== "string") {
      diagnostics.push(`${targetPath}.model must be a string when present.`);
    }

    if (
      target.thinking !== undefined &&
      !THINKING_LEVELS.has(target.thinking as WorkflowAgentThinking)
    ) {
      diagnostics.push(
        `${targetPath}.thinking must be one of low, medium, high, xhigh, or max when present.`,
      );
    }

    const args = parseOptionalStringArray(`${targetPath}.args`, target.args, diagnostics);

    return [
      {
        provider: target.provider,
        ...(typeof target.model === "string" ? { model: target.model } : {}),
        ...(typeof target.thinking === "string" &&
        THINKING_LEVELS.has(target.thinking as WorkflowAgentThinking)
          ? { thinking: target.thinking as WorkflowAgentThinking }
          : {}),
        ...(args === undefined ? {} : { args }),
      },
    ];
  });
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

function parseOptionalStringArray(
  path: string,
  value: unknown,
  diagnostics: string[],
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    diagnostics.push(`${path} must be an array of strings when present.`);
    return undefined;
  }

  return value;
}

function parseOptionalStringRecord(
  path: string,
  value: unknown,
  diagnostics: string[],
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push(`${path} must be an object when present.`);
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") {
      diagnostics.push(`${path}.${key} must be a string.`);
    } else {
      env[key] = envValue;
    }
  }

  return env;
}

function throwValidationFailure(diagnostics: readonly string[]): never {
  throw new StepKitFailureError(
    validationFailure("Invalid .stepkit/config.json.", { diagnostics }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
