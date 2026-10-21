import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../failures/failure.js";
import {
  type AgentExecutionConfig,
  DEFAULT_AGENT_EXECUTION,
  resolveAgentExecutionConfig,
} from "./agent-execution.types.js";

describe("resolveAgentExecutionConfig", () => {
  it("applies lean defaults for an empty execution block", () => {
    expect(resolveAgentExecutionConfig({})).toEqual({
      tools: "*",
      skills: [],
      mcp: false,
      extensions: [],
      contextFiles: true,
    });
    expect(DEFAULT_AGENT_EXECUTION.contextFiles).toBe(true);
  });

  it("keeps explicitly configured values", () => {
    const config: AgentExecutionConfig = {
      tools: ["Read", "Grep"],
      skills: ["trst-delegate"],
      mcp: true,
      extensions: ["./ext.js"],
      contextFiles: true,
    };

    expect(resolveAgentExecutionConfig(config)).toEqual({
      tools: ["Read", "Grep"],
      skills: ["trst-delegate"],
      mcp: true,
      extensions: ["./ext.js"],
      contextFiles: true,
    });
  });

  it("accepts contextFiles false and partial blocks", () => {
    expect(resolveAgentExecutionConfig({ contextFiles: false, mcp: true })).toEqual({
      tools: "*",
      skills: [],
      mcp: true,
      extensions: [],
      contextFiles: false,
    });
    expect(resolveAgentExecutionConfig({ tools: "*" }).tools).toBe("*");
  });

  it("reports every invalid field in one agent_execution_invalid failure", () => {
    let caught: unknown;
    try {
      resolveAgentExecutionConfig({
        tools: [],
        skills: [""],
        mcp: "yes",
        extensions: [42],
        contextFiles: "all",
      } as unknown as AgentExecutionConfig);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TrailStepFailureError);
    const failure = (caught as TrailStepFailureError).failure;
    expect(failure.code).toBe("agent_execution_invalid");
    expect(failure.details).toEqual({
      diagnostics: [
        'execution.tools must be "*" or a non-empty array of tool names when present.',
        "execution.skills must be an array of non-empty strings when present.",
        "execution.mcp must be a boolean when present.",
        "execution.extensions must be an array of non-empty strings when present.",
        'execution.contextFiles must be a boolean or "project-only" when present.',
      ],
    });
  });

  it("rejects non-array tools", () => {
    expect(() =>
      resolveAgentExecutionConfig({ tools: "Read" as unknown as "*" | readonly string[] }),
    ).toThrow(TrailStepFailureError);
  });
});
