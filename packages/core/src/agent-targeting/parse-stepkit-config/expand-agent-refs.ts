import { StepKitFailureError } from "../../contracts/failures/failure.js";
import type { StepKitAgentMappings, StepKitAgentTarget } from "../targeting.types.js";
import type { RawStepKitAgentMappings, RawStepKitAgentTarget } from "./parse-agent-targets.js";

export function expandAgentRefs(options: {
  readonly agents: RawStepKitAgentMappings;
  readonly workflows:
    | Readonly<
        Record<
          string,
          {
            readonly agents?: RawStepKitAgentMappings;
            readonly settings?: Readonly<Record<string, unknown>>;
          }
        >
      >
    | undefined;
}): {
  readonly agents: StepKitAgentMappings;
  readonly workflows:
    | Readonly<
        Record<
          string,
          {
            readonly agents?: StepKitAgentMappings;
            readonly settings?: Readonly<Record<string, unknown>>;
          }
        >
      >
    | undefined;
} {
  const expandedAgents: Record<string, readonly StepKitAgentTarget[]> = {};
  const memo = new Map<string, readonly StepKitAgentTarget[]>();

  for (const name of Object.keys(options.agents)) {
    expandedAgents[name] = expandTopLevelAgent({
      name,
      agents: options.agents,
      memo,
      stack: [],
      rootRefPath: undefined,
    });
  }

  const expandedWorkflows =
    options.workflows === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(options.workflows).map(([workflowId, workflow]) => {
            const workflowAgents =
              workflow.agents === undefined
                ? undefined
                : Object.fromEntries(
                    Object.entries(workflow.agents).map(([roleName, targets]) => [
                      roleName,
                      expandTargetArray({
                        path: `workflows.${workflowId}.agents.${roleName}`,
                        targets,
                        agents: options.agents,
                        memo,
                        stack: [],
                        rootRefPath: undefined,
                      }),
                    ]),
                  );

            return [
              workflowId,
              {
                ...(workflowAgents === undefined ? {} : { agents: workflowAgents }),
                ...(workflow.settings === undefined ? {} : { settings: workflow.settings }),
              },
            ];
          }),
        );

  return { agents: expandedAgents, workflows: expandedWorkflows };
}

function expandTopLevelAgent(options: {
  readonly name: string;
  readonly agents: RawStepKitAgentMappings;
  readonly memo: Map<string, readonly StepKitAgentTarget[]>;
  readonly stack: readonly string[];
  readonly rootRefPath: string | undefined;
}): readonly StepKitAgentTarget[] {
  const memoized = options.memo.get(options.name);
  if (memoized !== undefined) {
    return memoized;
  }

  const targets = options.agents[options.name];
  if (targets === undefined) {
    throwUnknownRef(`agents.${options.name}`, options.name);
  }

  const expanded = expandTargetArray({
    path: `agents.${options.name}`,
    targets,
    agents: options.agents,
    memo: options.memo,
    stack: [...options.stack, options.name],
    rootRefPath: options.rootRefPath,
  });
  options.memo.set(options.name, expanded);
  return expanded;
}

function expandTargetArray(options: {
  readonly path: string;
  readonly targets: readonly RawStepKitAgentTarget[];
  readonly agents: RawStepKitAgentMappings;
  readonly memo: Map<string, readonly StepKitAgentTarget[]>;
  readonly stack: readonly string[];
  readonly rootRefPath: string | undefined;
}): readonly StepKitAgentTarget[] {
  return options.targets.flatMap((target, index) => {
    if ("provider" in target) {
      return [target];
    }

    const refPath = `${options.path}.items[${index}].ref`;
    const referencedTargets = options.agents[target.ref];
    if (referencedTargets === undefined) {
      throwUnknownRef(refPath, target.ref);
    }

    const existingRefIndex = options.stack.indexOf(target.ref);
    if (existingRefIndex !== -1) {
      throwCycle(options.rootRefPath ?? refPath, [
        ...options.stack.slice(existingRefIndex),
        target.ref,
      ]);
    }

    const memoized = options.memo.get(target.ref);
    if (memoized !== undefined) {
      return memoized;
    }

    const expanded = expandTargetArray({
      path: `agents.${target.ref}`,
      targets: referencedTargets,
      agents: options.agents,
      memo: options.memo,
      stack: [...options.stack, target.ref],
      rootRefPath: options.rootRefPath ?? refPath,
    });
    options.memo.set(target.ref, expanded);
    return expanded;
  });
}

function throwUnknownRef(path: string, ref: string): never {
  throw new StepKitFailureError({
    code: "agent_ref_unknown",
    message: "One or more agent refs reference an unknown top-level agent.",
    details: { diagnostics: [`${path} references unknown agent '${ref}'.`] },
  });
}

function throwCycle(path: string, cycle: readonly string[]): never {
  throw new StepKitFailureError({
    code: "agent_ref_cycle",
    message: "One or more agent refs create a cycle.",
    details: { diagnostics: [`${path} creates an agent ref cycle: ${cycle.join(" -> ")}.`] },
  });
}
