import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  type AgentAdapter,
  done,
  jsonSchema,
  parseTrailStepConfig,
  promptTemplate,
  runWorkflow,
  step,
  type Workflow,
  type WorkingAgentProcessRequest,
} from "../../../index.js";

describe("agent steps", () => {
  it("core source does not expose provider SDK adapter registry exports", async () => {
    const forbiddenPatterns = [
      "Cl" + "aude",
      "cl" + "aude-agent-sdk",
      "Anth" + "ropic",
      "jsonSchemaTo" + "ZodRawShape",
      "CL" + "AUDE",
    ];
    const checkedFiles = [
      "src/agent-execution/adapter-agent/run-adapter-agent-step/run-adapter-agent-step.ts",
      "src/index.ts",
      "package.json",
    ];

    for (const file of checkedFiles) {
      const contents = await readFile(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(contents, `${file} should not contain ${pattern}`).not.toContain(pattern);
      }
    }
  });

  it("chains an agent step into a code step through a custom adapter and validates submitted structured output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-agent-"));
    const agentOutputSchema = jsonSchema<{ answer: string }>({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    });
    const finalOutputSchema = jsonSchema<{ final: string }>({
      type: "object",
      properties: { final: { type: "string" } },
      required: ["final"],
      additionalProperties: false,
    });

    const adapter: AgentAdapter<{ task: string }, { answer: string }> = async (request) => {
      expect(request.input).toEqual({ task: "summarize" });
      expect(request.requirements).toEqual({ size: "small", name: "helper" });
      expect(request.model).toEqual({ adapterKey: "custom", model: "helper" });
      const submitOutput = request.tools.find((tool) => tool.name === "submit_output");
      expect(submitOutput).toBeDefined();
      await submitOutput?.call({ answer: `done: ${request.input.task}` });
    };

    const agentStep = step({
      id: "agent",
    })
      .prompt("Return a short answer.", {
        output: agentOutputSchema,
        agent: "helper",
        adapter,
      })
      .do((agentOutput) => finalizeStep(agentOutput));

    const finalizeStep = step({
      id: "finalize",
    }).do((finalizeInput) => done({ final: finalizeInput.answer }));

    const workflow: Workflow<{ task: string }, { final: string }> = {
      id: "agent-workflow",
      inputShape: { task: "string" },
      outputShape: finalOutputSchema,
      agents: { helper: { size: "small", name: "helper" } },
      start(input) {
        return agentStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "summarize" },
      runName: "agent-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ final: "done: summarize" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "agent.toolCall",
      "step.completed",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(result.events[2]?.payload).toMatchObject({
      name: "submit_output",
      input: { answer: "done: summarize" },
      output: { accepted: true },
    });
  });

  it("renders an agent prompt from live step input and passes it to a custom adapter", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-unified-agent-"));
    const finalOutputSchema = jsonSchema<{ answer: string }>({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    });

    let capturedPrompt: string | undefined;
    let capturedInput: { task: string } | undefined;

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "unified-agent-workflow",
      inputShape: { task: "string" },
      output: finalOutputSchema,
      agents: { helper: { size: "small", name: "helper" } },
      start(input) {
        return step({
          id: "agent",
        })
          .prompt(({ input }) => `Summarize ${input.task}.`, {
            output: { answer: "string" },
            agent: "helper",
            adapter: async (request) => {
              capturedPrompt = request.messages[0]?.content;
              capturedInput = request.input as { task: string };
              await request.tools[0]?.call({ answer: `done: ${capturedInput.task}` });
            },
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "live-input" },
      runName: "unified-agent-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ answer: "done: live-input" });
    expect(capturedPrompt).toBe("Summarize live-input.");
    expect(capturedInput).toEqual({ task: "live-input" });
  });

  it("runs a continuation agent role through a configured command and validates output.json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-command-agent-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: {
        reviewer: { size: "medium", description: "Review answers" },
      },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "alpha" },
      runName: "command-agent-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: {
          local: {
            binary: "local-agent",
            args: ["{{promptFile}}", "{{outputFile}}", "{{model}}"],
          },
        },
        agents: { medium: [{ provider: "local", model: "test-model" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        await writeFile(request.outputFile, JSON.stringify({ answer: "reviewed-alpha" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ answer: "reviewed-alpha" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "local-agent",
      args: [requests[0]?.promptFile, requests[0]?.outputFile, "test-model"],
      cwd,
      shell: false,
      stdio: "inherit",
    });
    expect(requests[0]?.promptFile).toBe(join(result.runDir, "steps", "0001-review", "prompt.md"));
    expect(requests[0]?.outputFile).toBe(
      join(result.runDir, "steps", "0001-review", "output.json"),
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("falls back to the second working-agent target after invalid JSON", async () => {
    const cwd = await mkdtemp(
      join(tmpdir(), "trailstep-core-command-agent-fallback-invalid-json-"),
    );
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-fallback-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "gamma" },
      runName: "command-agent-fallback-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: {
          broken: { binary: "broken-agent" },
          local: { binary: "local-agent" },
        },
        agents: {
          medium: [
            { provider: "broken", model: "bad-model" },
            { provider: "local", model: "good-model" },
          ],
        },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        if (request.model === "bad-model") {
          await writeFile(request.outputFile, "not json", "utf8");
          return { exitCode: 0 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "fallback-ok" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ answer: "fallback-ok" });
    expect(requests.map((request) => request.model)).toEqual(["bad-model", "good-model"]);
    expect(requests.map((request) => request.outputFile)).toEqual([
      join(result.runDir, "steps", "0001-review", "output.json"),
      join(result.runDir, "steps", "0001-review", "output.json"),
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("falls back to agents.default when role and size mappings are unusable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-command-agent-default-fallback-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-default-fallback-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "delta" },
      runName: "command-agent-default-fallback-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: {
          role: { binary: "role-agent" },
          size: { binary: "size-agent" },
          default: { binary: "default-agent" },
        },
        agents: {
          small: [{ provider: "size", model: "size-model" }],
          default: [{ provider: "default", model: "default-model" }],
        },
        workflows: {
          "command-agent-default-fallback-workflow": {
            agents: { reviewer: [{ provider: "role", model: "role-model" }] },
          },
        },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        if (request.model === "default-model") {
          await writeFile(request.outputFile, JSON.stringify({ answer: "default-ok" }), "utf8");
          return { exitCode: 0 };
        }
        return { exitCode: 1 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ answer: "default-ok" });
    expect(requests.map((request) => request.model)).toEqual([
      "role-model",
      "size-model",
      "default-model",
    ]);
  });

  it("fails with agent_target_exhausted after all targets fail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-command-agent-exhausted-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-exhausted-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "epsilon" },
      runName: "command-agent-exhausted-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: {
          first: { binary: "first-agent" },
          second: { binary: "second-agent" },
        },
        agents: {
          medium: [{ provider: "first", model: "first-model" }],
          default: [{ provider: "second", model: "second-model" }],
        },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        if (request.model === "first-model") {
          return { exitCode: 9 };
        }
        await writeFile(request.outputFile, JSON.stringify({ wrong: "shape" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected all targets to fail");
    }
    expect(result.failure.code).toBe("agent_target_exhausted");
    expect(result.failure.message).toContain("review");
    expect(result.failure.message).toContain("reviewer");
    expect(result.failure.details).toMatchObject({
      roleName: "reviewer",
      attempts: [
        { target: "first", model: "first-model", code: "agent_provider_failed" },
        { target: "second", model: "second-model", code: "validation_failed" },
      ],
    });
    expect(JSON.stringify(result.failure.details)).not.toContain("epsilon");
    expect(requests.map((request) => request.model)).toEqual(["first-model", "second-model"]);
  });

  it("writes prompt.md with output-file and schema instructions before invoking the command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-command-agent-prompt-"));
    let promptFileBeforeRun: string | undefined;
    let promptTextBeforeRun: string | undefined;

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-prompt-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Original prompt for ${input.task}.`, {
            output: { answer: "string" },
            agent: "reviewer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "beta" },
      runName: "command-agent-prompt-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: { local: { binary: "local-agent" } },
        agents: { small: [{ provider: "local" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        promptFileBeforeRun = request.promptFile;
        promptTextBeforeRun = await readFile(request.promptFile, "utf8");
        await writeFile(request.outputFile, JSON.stringify({ answer: "ok" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(promptFileBeforeRun).toBe(join(result.runDir, "steps", "0001-review", "prompt.md"));
    expect(promptTextBeforeRun).toContain("Original prompt for beta.");
    expect(promptTextBeforeRun).toContain("write exactly one JSON object");
    expect(promptTextBeforeRun).toContain(
      join(result.runDir, "steps", "0001-review", "output.json"),
    );
    expect(promptTextBeforeRun).toContain('"answer"');
  });
});

describe("provider registration dispatch", () => {
  it("dispatches a config.providers registration even when legacy customProviders are also present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-provider-registration-priority-"));
    const manifestRequests: WorkingAgentProcessRequest[] = [];
    const customRequests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "provider-registration-priority-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small" } },
      start(input) {
        return step({
          id: "greet",
        })
          .prompt(({ input }) => `Greet ${input.name}.`, {
            output: { greeting: "string" },
            agent: "writer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Bea" },
      runName: "provider-registration-priority-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: { legacy: { binary: "should-not-run" } },
        providers: {
          claude: {
            source: { type: "local-manifest", path: "./claude.trailstep-provider.json" },
            manifest: {
              schemaVersion: 1,
              id: "claude",
              displayName: "Claude",
              working: {
                supported: true,
                command: "package-claude",
                args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
                prompt: { kind: "prompt-file" },
                output: { style: "provider-output-file" },
              },
              interactive: { supported: false },
              model: { supported: false },
              thinking: { supported: false },
            },
          },
        },
        agents: { small: [{ provider: "claude" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        if (request.command === "package-claude") {
          manifestRequests.push(request);
          await writeFile(request.outputFile, JSON.stringify({ greeting: "Hello, Bea!" }), "utf8");
          return { exitCode: 0 };
        }
        customRequests.push(request);
        return { exitCode: 1 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ greeting: "Hello, Bea!" });
    expect(manifestRequests).toHaveLength(1);
    expect(customRequests).toHaveLength(0);
  });

  it("still dispatches a provider name that is only a customProviders key through the command path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-customagents-fallback-"));
    const legacyRequests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "customagents-fallback-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small" } },
      start(input) {
        return step({
          id: "greet",
        })
          .prompt(({ input }) => `Greet ${input.name}.`, {
            output: { greeting: "string" },
            agent: "writer",
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Cy" },
      runName: "customagents-fallback-run",
      cwd,
      trailstepConfig: parseTrailStepConfig({
        version: 1,
        customProviders: { "local-cli": { binary: "local-cli" } },
        agents: { small: [{ provider: "local-cli" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        legacyRequests.push(request);
        await writeFile(request.outputFile, JSON.stringify({ greeting: "Hello, Cy!" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ greeting: "Hello, Cy!" });
    expect(legacyRequests).toHaveLength(1);
    expect(legacyRequests[0]?.command).toBe("local-cli");
  });

  it("rejects a target whose provider matches neither providers nor customProviders with agent_provider_unknown", () => {
    expect(() =>
      parseTrailStepConfig({
        version: 1,
        customProviders: {},
        agents: { small: [{ provider: "totally-unknown-provider" }] },
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ code: "agent_provider_unknown" }),
      }),
    );
  });
});

describe("promptTemplate prompt source", () => {
  it("resolves a step's prompt from a local file relative to cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-prompt-template-"));
    await writeFile(join(cwd, "prompt.md"), "Say hello.", "utf8");
    const outputSchema = jsonSchema<{ answer: string }>({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    });

    let capturedPrompt: string | undefined;
    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "prompt-template-workflow",
      inputShape: { task: "string" },
      outputShape: outputSchema,
      agents: { assistant: { size: "small" } },
      start(input) {
        return step({
          id: "ask",
        })
          .prompt(promptTemplate("prompt.md"), {
            output: outputSchema,
            agent: "assistant",
            adapter: async (request) => {
              capturedPrompt = request.messages[0]?.content;
              await request.tools[0]?.call({ answer: "hi" });
            },
          })
          .do((output) => done(output))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "greet" },
      runName: "prompt-template-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(capturedPrompt).toBe("Say hello.");
    expect(result.output).toEqual({ answer: "hi" });
  });

  it("routes an unreadable promptTemplate file through normal step failure, recoverable via .catch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-prompt-template-missing-"));
    const outputSchema = jsonSchema<{ answer: string }>({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    });

    const workflow: Workflow<{ task: string }, { status: string }> = {
      id: "prompt-template-missing-workflow",
      inputShape: { task: "string" },
      outputShape: { status: "string" },
      agents: { assistant: { size: "small" } },
      start(input) {
        return step({
          id: "ask",
        })
          .prompt(promptTemplate("missing.md"), {
            output: outputSchema,
            agent: "assistant",
            adapter: async () => {
              throw new Error("should not run");
            },
          })
          .do(() => done({ status: "unexpected" }))
          .catch((failure) => done({ status: `failed: ${failure.code}: ${failure.message}` }))(
          input,
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "greet" },
      runName: "prompt-template-missing-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected workflow to recover through .catch");
    }
    expect(result.output.status).toContain("failed: step_execution_failed");
    expect(result.output.status).toMatch(/ENOENT|no such file/i);
    expect(result.output.status).toContain("missing.md");
  });
});
