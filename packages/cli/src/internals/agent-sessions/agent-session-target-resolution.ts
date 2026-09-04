import type { TrailStepAgentTarget, TrailStepConfig } from "@trailstep/core";

import { isOfficialProviderId } from "../official-provider-specs.js";

export type AgentSessionResolutionKind =
  | "default-agent"
  | "configured-agent"
  | "built-in-provider"
  | "custom-provider";

export interface ResolvedAgentSessionTarget {
  readonly requestedName?: string;
  readonly resolutionKind: AgentSessionResolutionKind;
  readonly agentName?: string;
  readonly target: TrailStepAgentTarget;
  readonly providerName: string;
}

export class AgentSessionTargetResolutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "default-agent-missing"
      | "configured-agent-empty"
      | "target-not-openable"
      | "custom-provider-interactive-unsupported",
  ) {
    super(message);
    this.name = "AgentSessionTargetResolutionError";
  }
}

export function resolveAgentSessionTarget(options: {
  readonly config: TrailStepConfig | undefined;
  readonly requestedName?: string;
}): ResolvedAgentSessionTarget {
  const { config, requestedName } = options;

  if (requestedName === undefined) {
    const target = config?.agents.default?.[0];
    if (!target) {
      throw new AgentSessionTargetResolutionError(
        "No default agent is configured. Run `trailstep init` or `trailstep agents` to configure agents.default before using `trailstep open`.",
        "default-agent-missing",
      );
    }

    return {
      resolutionKind: "default-agent",
      agentName: "default",
      target,
      providerName: target.provider,
    };
  }

  const configuredAgent = config?.agents[requestedName];
  if (configuredAgent !== undefined) {
    const target = configuredAgent[0];
    if (!target) {
      throw new AgentSessionTargetResolutionError(
        `Configured agent '${requestedName}' has no targets. Add at least one target before using \`trailstep open ${requestedName}\`.`,
        "configured-agent-empty",
      );
    }

    // MVP assumption: explicit configured agent names win over provider shortcuts when both exist.
    return {
      requestedName,
      resolutionKind: "configured-agent",
      agentName: requestedName,
      target,
      providerName: target.provider,
    };
  }

  if (isOfficialProviderId(requestedName)) {
    return {
      requestedName,
      resolutionKind: "built-in-provider",
      target: { provider: requestedName },
      providerName: requestedName,
    };
  }

  const customProvider = config?.customProviders[requestedName];
  if (customProvider !== undefined) {
    if (!customProvider.interactiveArgs) {
      throw new AgentSessionTargetResolutionError(
        `Custom provider '${requestedName}' is not openable because customProviders.${requestedName}.interactiveArgs is not declared.`,
        "custom-provider-interactive-unsupported",
      );
    }

    return {
      requestedName,
      resolutionKind: "custom-provider",
      target: { provider: requestedName },
      providerName: requestedName,
    };
  }

  throw new AgentSessionTargetResolutionError(
    `No openable agent or provider named '${requestedName}' was found. Use a configured agent name, official provider name, or custom provider with interactiveArgs.`,
    "target-not-openable",
  );
}
