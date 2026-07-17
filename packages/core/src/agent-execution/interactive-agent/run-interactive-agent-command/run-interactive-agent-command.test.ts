import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  done,
  type InteractiveProcessRunner,
  runWorkflow,
  step,
  type Workflow,
} from "../../../index.js";

describe("continuation interactive agent roles", () => {
  it("resolves a continuation interactive agent role from interactiveAgents instead of workingAgents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-interactive-agent-"));
    const runnerCalls: Parameters<InteractiveProcessRunner>[0][] = [];
    const workflow: Workflow<{ task: string }, { exitCode: number }> = {
      id: "interactive-agent-workflow",
      inputShape: { task: "string" },
      outputShape: { exitCode: "number" },
      agents: {
        implementor: { description: "Implements changes.", size: "large" },
      },
      start(input) {
        return step({
          id: "implement",
          outputShape: { exitCode: "number" },
          agent: "implementor",
          agentMode: "interactive",
        })
          .prompt(({ input }) => `Implement ${input.task}.`)
          .next(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "feature" },
      runName: "interactive-agent-run",
      cwd,
      stepkitConfig: {
        version: 1,
        customAgents: {
          working: { binary: "working-agent", args: ["{{promptFile}}"] },
          interactive: { binary: "interactive-agent", args: ["{{promptFile}}"] },
        },
        workingAgents: {
          large: [{ provider: "working", model: "working-model" }],
        },
        interactiveAgents: {
          large: [{ provider: "interactive", model: "interactive-model" }],
        },
      },
      processRunner: async (call) => {
        runnerCalls.push(call);
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({
      command: "interactive-agent",
      shell: false,
      stdio: "inherit",
    });
    expect(runnerCalls[0]?.command).not.toBe("working-agent");
    expect(result.output).toEqual({ exitCode: 0 });
  });

  it("passes rendered prompt to configured interactive command without a shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-interactive-prompt-"));
    const runnerCalls: Parameters<InteractiveProcessRunner>[0][] = [];
    const workflow: Workflow<{ task: string }, { exitCode: number }> = {
      id: "interactive-prompt-workflow",
      inputShape: { task: "string" },
      outputShape: { exitCode: "number" },
      agents: {
        implementor: { size: "small" },
      },
      start(input) {
        return step({
          id: "discuss",
          outputShape: { exitCode: "number" },
          agent: "implementor",
          agentMode: "interactive",
        })
          .prompt(({ input }) => `Discuss ${input.task}.`)
          .next(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "prompt handoff" },
      runName: "interactive-prompt-run",
      cwd,
      stepkitConfig: {
        version: 1,
        customAgents: {
          terminalAgent: {
            binary: "terminal-agent",
            args: ["--message-file", "{{promptFile}}", "--literal", "&&"],
          },
        },
        workingAgents: {
          small: [{ provider: "terminalAgent", model: "wrong-mode" }],
        },
        interactiveAgents: {
          small: [{ provider: "terminalAgent", model: "right-mode" }],
        },
      },
      processRunner: async (call) => {
        runnerCalls.push(call);
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const promptFile = join(result.runDir, "steps", "discuss", "prompt.txt");
    expect(runnerCalls[0]).toMatchObject({
      command: "terminal-agent",
      args: ["--message-file", promptFile, "--literal", "&&"],
      shell: false,
      stdio: "inherit",
    });
    await expect(readFile(promptFile, "utf8")).resolves.toBe("Discuss prompt handoff.");
  });

  it("dispatches an interactive target whose provider matches a registry key through the built-in provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-interactive-registry-"));
    const runnerCalls: Parameters<InteractiveProcessRunner>[0][] = [];
    const workflow: Workflow<{ task: string }, { exitCode: number }> = {
      id: "interactive-registry-workflow",
      inputShape: { task: "string" },
      outputShape: { exitCode: "number" },
      agents: {
        implementor: { size: "small" },
      },
      start(input) {
        return step({
          id: "discuss",
          outputShape: { exitCode: "number" },
          agent: "implementor",
          agentMode: "interactive",
        })
          .prompt(({ input }) => `Discuss ${input.task}.`)
          .next(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "prompt handoff" },
      runName: "interactive-registry-run",
      cwd,
      stepkitConfig: {
        version: 1,
        customAgents: {},
        workingAgents: {},
        interactiveAgents: {
          small: [{ provider: "claude", model: "opus" }],
        },
      },
      processRunner: async (call) => {
        runnerCalls.push(call);
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({
      command: "claude",
      args: ["--model", "opus", "Discuss prompt handoff."],
      shell: false,
      stdio: "inherit",
    });
  });
});
