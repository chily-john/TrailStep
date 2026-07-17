import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { ResolveAgentTargetsOptions, StepKitAgentTarget } from "../targeting.types.js";

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
