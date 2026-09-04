import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import type { ResolveAgentTargetsOptions, TrailStepAgentTarget } from "../targeting.types.js";

export function resolveAgentTargets(
  options: ResolveAgentTargetsOptions,
): readonly TrailStepAgentTarget[] {
  const workflowMappings = options.config.workflows?.[options.workflowId]?.agents;

  const topLevelAgentKeys = uniqueAgentKeys([options.roleName, options.roleSize, "default"]);
  const targetLists = [
    workflowMappings?.[options.roleName],
    ...topLevelAgentKeys.map((key) => options.config.agents[key]),
  ];

  const targets = targetLists.flatMap((targets) =>
    targets && targets.length > 0 ? [...targets] : [],
  );

  if (targets.length > 0) {
    return targets;
  }

  throw new TrailStepFailureError({
    code: "agent_targets_unavailable",
    message: `No agent targets found for role ${options.roleName} with size ${options.roleSize} in workflow ${options.workflowId}.`,
    details: {
      roleName: options.roleName,
      roleSize: options.roleSize,
      workflowId: options.workflowId,
    },
  });
}

function uniqueAgentKeys(keys: readonly string[]): readonly string[] {
  return keys.filter((key, index) => keys.indexOf(key) === index);
}
