import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../../contracts/failures/failure.js";
import { resolveExecutionPolicy } from "./execution-policy.js";

const LEAN_ROLE = {
  tools: "*",
  skills: [],
  mcp: false,
  extensions: [],
  contextFiles: true,
} as const;

describe("resolveExecutionPolicy", () => {
  it("returns undefined when no block exists anywhere", () => {
    expect(
      resolveExecutionPolicy({
        global: { path: "settings.execution", block: undefined },
        workflow: { path: "workflows.demo.settings.execution", block: undefined },
      }),
    ).toBeUndefined();
  });

  it("keeps the role block when no config block is present", () => {
    expect(resolveExecutionPolicy({ role: LEAN_ROLE })).toEqual({
      tools: "*",
      skills: [],
      mcp: false,
      extensions: [],
      contextFiles: true,
    });
  });

  it("merges config blocks field by field so unnamed role fields survive", () => {
    const resolved = resolveExecutionPolicy({
      role: LEAN_ROLE,
      global: { path: "settings.execution", block: { contextFiles: false } },
    });

    expect(resolved).toEqual({
      tools: "*",
      skills: [],
      mcp: false,
      extensions: [],
      contextFiles: false,
    });
  });

  it("lets the per-workflow config block win over the global one", () => {
    const resolved = resolveExecutionPolicy({
      role: LEAN_ROLE,
      global: { path: "settings.execution", block: { skills: ["global"], mcp: true } },
      workflow: {
        path: "workflows.demo.settings.execution",
        block: { skills: ["workflow"] },
      },
    });

    expect(resolved).toEqual({
      tools: "*",
      skills: ["workflow"],
      mcp: true,
      extensions: [],
      contextFiles: true,
    });
  });

  it("lets the step block win over every config block", () => {
    const resolved = resolveExecutionPolicy({
      role: LEAN_ROLE,
      global: { path: "settings.execution", block: { mcp: true, skills: ["global"] } },
      workflow: {
        path: "workflows.demo.settings.execution",
        block: { mcp: false, skills: ["workflow"] },
      },
      step: { skills: ["step"] },
    });

    expect(resolved).toEqual({
      tools: "*",
      skills: ["step"],
      mcp: false,
      extensions: [],
      contextFiles: true,
    });
  });

  it("lets an explicit false or empty list override a lower-precedence value", () => {
    const resolved = resolveExecutionPolicy({
      role: { ...LEAN_ROLE, skills: ["from-role"], mcp: true },
      global: { path: "settings.execution", block: { skills: [], mcp: false } },
    });

    expect(resolved).toMatchObject({ skills: [], mcp: false });
  });

  it("ignores unknown keys in a config block", () => {
    const resolved = resolveExecutionPolicy({
      global: { path: "settings.execution", block: { skills: ["x"], unknown: true } },
    });

    expect(resolved).toEqual({
      tools: "*",
      skills: ["x"],
      mcp: false,
      extensions: [],
      contextFiles: true,
    });
  });

  it("fails fast with a config-scoped diagnostic for an invalid config block", () => {
    let caught: unknown;
    try {
      resolveExecutionPolicy({
        global: { path: "settings.execution", block: { contextFiles: "sometimes" } },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TrailStepFailureError);
    const failure = (caught as TrailStepFailureError).failure;
    expect(failure.code).toBe("agent_execution_invalid");
    expect(failure.message).toContain("settings.execution");
    expect(JSON.stringify(failure.details)).toContain("settings.execution.contextFiles");
  });

  it("fails fast when a config block is not an object", () => {
    let caught: unknown;
    try {
      resolveExecutionPolicy({
        global: { path: "settings.execution", block: "nope" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TrailStepFailureError);
    expect((caught as TrailStepFailureError).failure.code).toBe("agent_execution_invalid");
  });

  it("fails fast for an invalid role block", () => {
    let caught: unknown;
    try {
      resolveExecutionPolicy({
        role: { mcp: "yes" } as unknown as typeof LEAN_ROLE,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TrailStepFailureError);
    expect((caught as TrailStepFailureError).failure.code).toBe("agent_execution_invalid");
  });
});
