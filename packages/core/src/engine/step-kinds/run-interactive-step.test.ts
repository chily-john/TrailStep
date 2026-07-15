import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  done,
  type InteractiveProcessRunner,
  jsonSchema,
  runWorkflow,
  step,
  type Workflow,
} from "../../index.js";

describe("interactive steps (deprecated static workflow compatibility)", () => {
  it("substitutes promptFile as one argv value and spawns without a shell for opaque output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-interactive-"));
    const events: string[] = [];
    const runnerCalls: Parameters<InteractiveProcessRunner>[0][] = [];
    const objectSchema = jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const workflow: Workflow<Record<string, never>, { exitCode: number }> = {
      id: "interactive-workflow",
      input: objectSchema,
      output: jsonSchema<{ exitCode: number }>({
        type: "object",
        properties: { exitCode: { type: "number" } },
        required: ["exitCode"],
        additionalProperties: false,
      }),
      steps: [
        {
          kind: "interactive",
          id: "ask-agent",
          command: 'agent --message "{{promptFile}}" --literal "&&"',
          prompt: "Use this prompt as opaque interactive input.",
          outputMode: "opaque",
          output: jsonSchema<{ exitCode: number }>({
            type: "object",
            properties: { exitCode: { type: "number" } },
            required: ["exitCode"],
            additionalProperties: false,
          }),
        },
      ],
    };

    const processRunner: InteractiveProcessRunner = async (call) => {
      runnerCalls.push(call);
      return { exitCode: 0 };
    };

    const result = await runWorkflow({
      workflow,
      input: {},
      runName: "interactive-run",
      cwd,
      processRunner,
      eventSink: (event) => {
        events.push(event.type);
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({
      command: "agent",
      args: [
        "--message",
        join(result.runDir, "steps", "ask-agent", "prompt.txt"),
        "--literal",
        "&&",
      ],
      shell: false,
      stdio: "inherit",
    });
    await expect(
      readFile(join(result.runDir, "steps", "ask-agent", "prompt.txt"), "utf8"),
    ).resolves.toBe("Use this prompt as opaque interactive input.");
    expect(result.output).toEqual({ exitCode: 0 });
    expect(events).toEqual([
      "workflow.started",
      "step.started",
      "interactive.sessionStarted",
      "interactive.sessionCompleted",
      "step.completed",
      "workflow.completed",
    ]);
  });
});

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
        return step(
          {
            id: "implement",
            input,
            outputShape: { exitCode: "number" },
            prompt: ({ input }) => `Implement ${input.task}.`,
            agent: "implementor",
            agentMode: "interactive",
          },
          done,
        );
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
        return step(
          {
            id: "discuss",
            input,
            outputShape: { exitCode: "number" },
            prompt: ({ input }) => `Discuss ${input.task}.`,
            agent: "implementor",
            agentMode: "interactive",
          },
          done,
        );
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
        return step(
          {
            id: "discuss",
            input,
            outputShape: { exitCode: "number" },
            prompt: ({ input }) => `Discuss ${input.task}.`,
            agent: "implementor",
            agentMode: "interactive",
          },
          done,
        );
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
