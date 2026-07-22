import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { ResolveAgentTargetsOptions, StepKitAgentTarget } from "../targeting.types.js";

export function resolveAgentTargets(
  options: ResolveAgentTargetsOptions,
): readonly StepKitAgentTarget[] {
  const workflowMappings = options.config.workflows?.[options.workflowId]?.agents;

  const targetLists = [
    workflowMappings?.[options.roleName],
    options.config.agents[options.roleSize],
    options.config.agents.default,
  ];

  const targets = targetLists.flatMap((targets) =>
    targets && targets.length > 0 ? [...targets] : [],
  );

  if (targets.length > 0) {
    return targets;
  }

  throw new StepKitFailureError({
    code: "agent_targets_unavailable",
    message: `No agent targets found for role ${options.roleName} with size ${options.roleSize} in workflow ${options.workflowId}.`,
    details: {
      roleName: options.roleName,
      roleSize: options.roleSize,
      workflowId: options.workflowId,
    },
  });
}
