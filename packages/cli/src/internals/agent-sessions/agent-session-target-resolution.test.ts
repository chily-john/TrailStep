import { parseTrailStepConfig } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import { withTestCustomProviders } from "../../test/provider-fixtures.js";
import {
  AgentSessionTargetResolutionError,
  resolveAgentSessionTarget,
} from "./agent-session-target-resolution.js";

function config(value: Record<string, unknown>) {
  return parseTrailStepConfig(withTestCustomProviders(value));
}

describe("resolveAgentSessionTarget", () => {
  it("resolves the first target for the default agent", () => {
    const resolved = resolveAgentSessionTarget({
      config: config({
        version: 1,
        customProviders: {},
        agents: { default: [{ provider: "claude" }, { provider: "codex" }] },
      }),
    });

    expect(resolved).toMatchObject({
      resolutionKind: "default-agent",
      agentName: "default",
      providerName: "claude",
      target: { provider: "claude" },
    });
  });

  it("resolves the first target for a named configured agent", () => {
    const resolved = resolveAgentSessionTarget({
      requestedName: "reviewer",
      config: config({
        version: 1,
        customProviders: {},
        agents: { reviewer: [{ provider: "pi", model: "fast" }, { provider: "codex" }] },
      }),
    });

    expect(resolved).toMatchObject({
      requestedName: "reviewer",
      resolutionKind: "configured-agent",
      agentName: "reviewer",
      providerName: "pi",
      target: { provider: "pi", model: "fast" },
    });
  });

  it("resolves a built-in provider as an ephemeral target", () => {
    expect(
      resolveAgentSessionTarget({
        requestedName: "claude",
        config: config({ version: 1, customProviders: {}, agents: {} }),
      }),
    ).toMatchObject({
      requestedName: "claude",
      resolutionKind: "built-in-provider",
      providerName: "claude",
      target: { provider: "claude" },
    });
  });

  it("resolves a custom provider with interactive args as an ephemeral target", () => {
    expect(
      resolveAgentSessionTarget({
        requestedName: "local",
        config: config({
          version: 1,
          customProviders: {
            local: { binary: "local-agent", interactiveArgs: ["{{promptFile}}"] },
          },
          agents: {},
        }),
      }),
    ).toMatchObject({
      requestedName: "local",
      resolutionKind: "custom-provider",
      providerName: "local",
      target: { provider: "local" },
    });
  });

  it("prefers a configured agent over a provider with the same name", () => {
    const resolved = resolveAgentSessionTarget({
      requestedName: "claude",
      config: config({
        version: 1,
        customProviders: {},
        agents: { claude: [{ provider: "codex", model: "configured-wins" }] },
      }),
    });

    expect(resolved).toMatchObject({
      resolutionKind: "configured-agent",
      agentName: "claude",
      providerName: "codex",
      target: { provider: "codex", model: "configured-wins" },
    });
  });

  it("fails when the named configured agent has no targets", () => {
    expect(() =>
      resolveAgentSessionTarget({
        requestedName: "empty",
        config: config({ version: 1, customProviders: {}, agents: { empty: [] } }),
      }),
    ).toThrow(AgentSessionTargetResolutionError);

    expect(() =>
      resolveAgentSessionTarget({
        requestedName: "empty",
        config: config({ version: 1, customProviders: {}, agents: { empty: [] } }),
      }),
    ).toThrow(/has no targets/i);
  });

  it("fails when no openable agent or provider exists", () => {
    expect(() =>
      resolveAgentSessionTarget({
        requestedName: "workflowOnly",
        config: config({ version: 1, customProviders: {}, agents: {} }),
      }),
    ).toThrow(/no openable agent or provider named 'workflowOnly'/i);
  });
});
