import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AgentAdapter,
  done,
  jsonSchema,
  type ProviderWorkingProcessRequest,
  parseStepKitConfig,
  runWorkflow,
  step,
  type Workflow,
  type WorkingAgentProcessRequest,
} from "../../index.js";

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
      "src/engine/step-kinds/run-agent-step.ts",
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-agent-"));
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

    const workflow: Workflow<{ task: string }, { final: string }> = {
      id: "agent-workflow",
      inputShape: { task: "string" },
      outputShape: finalOutputSchema,
      start(input) {
        return step(
          {
            id: "agent",
            input,
            outputShape: agentOutputSchema,
            prompt: "Return a short answer.",
            requirements: { size: "small", name: "helper" },
            adapter,
          },
          (agentOutput) =>
            step(
              {
                id: "finalize",
                input: agentOutput,
                outputShape: finalOutputSchema,
                run: (finalizeInput) => ({ final: finalizeInput.answer }),
              },
              (output) => done(output),
            ),
        );
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-unified-agent-"));
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
      start(input) {
        return step(
          {
            id: "agent",
            input,
            outputShape: { answer: "string" },
            prompt: ({ input }) => `Summarize ${input.task}.`,
            requirements: { size: "small", name: "helper" },
            adapter: async (request) => {
              capturedPrompt = request.messages[0]?.content;
              capturedInput = request.input as { task: string };
              await request.tools[0]?.call({ answer: `done: ${capturedInput.task}` });
            },
          },
          (output) => done(output),
        );
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-command-agent-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: {
        reviewer: { size: "medium", description: "Review answers" },
      },
      start(input) {
        return step(
          {
            id: "review",
            input,
            outputShape: { answer: "string" },
            agent: "reviewer",
            prompt: ({ input }) => `Review ${input.task}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "alpha" },
      runName: "command-agent-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {
          local: {
            binary: "local-agent",
            args: ["{{promptFile}}", "{{outputFile}}", "{{model}}"],
          },
        },
        workingAgents: { medium: [{ provider: "local", model: "test-model" }] },
        interactiveAgents: {},
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
      cwd: result.runDir,
      shell: false,
      stdio: "inherit",
    });
    expect(requests[0]?.promptFile).toBe(join(result.runDir, "steps", "review", "prompt.md"));
    expect(requests[0]?.outputFile).toBe(join(result.runDir, "steps", "review", "output.json"));
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("falls back to the second working-agent target after invalid JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-command-agent-fallback-invalid-json-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-fallback-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step(
          {
            id: "review",
            input,
            outputShape: { answer: "string" },
            agent: "reviewer",
            prompt: ({ input }) => `Review ${input.task}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "gamma" },
      runName: "command-agent-fallback-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {
          broken: { binary: "broken-agent" },
          local: { binary: "local-agent" },
        },
        workingAgents: {
          medium: [
            { provider: "broken", model: "bad-model" },
            { provider: "local", model: "good-model" },
          ],
        },
        interactiveAgents: {},
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
      join(result.runDir, "steps", "review", "output.json"),
      join(result.runDir, "steps", "review", "output.json"),
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
  });

  it("falls back to workingAgents.default when role and size mappings are unusable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-command-agent-default-fallback-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-default-fallback-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step(
          {
            id: "review",
            input,
            outputShape: { answer: "string" },
            agent: "reviewer",
            prompt: ({ input }) => `Review ${input.task}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "delta" },
      runName: "command-agent-default-fallback-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {
          role: { binary: "role-agent" },
          size: { binary: "size-agent" },
          default: { binary: "default-agent" },
        },
        workingAgents: {
          small: [{ provider: "size", model: "size-model" }],
          default: [{ provider: "default", model: "default-model" }],
        },
        interactiveAgents: {},
        workflows: {
          "command-agent-default-fallback-workflow": {
            workingAgents: { reviewer: [{ provider: "role", model: "role-model" }] },
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-command-agent-exhausted-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-exhausted-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step(
          {
            id: "review",
            input,
            outputShape: { answer: "string" },
            agent: "reviewer",
            prompt: ({ input }) => `Review ${input.task}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "epsilon" },
      runName: "command-agent-exhausted-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {
          first: { binary: "first-agent" },
          second: { binary: "second-agent" },
        },
        workingAgents: {
          medium: [{ provider: "first", model: "first-model" }],
          default: [{ provider: "second", model: "second-model" }],
        },
        interactiveAgents: {},
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-command-agent-prompt-"));
    let promptFileBeforeRun: string | undefined;
    let promptTextBeforeRun: string | undefined;

    const workflow: Workflow<{ task: string }, { answer: string }> = {
      id: "command-agent-prompt-workflow",
      inputShape: { task: "string" },
      outputShape: { answer: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step(
          {
            id: "review",
            input,
            outputShape: { answer: "string" },
            agent: "reviewer",
            prompt: ({ input }) => `Original prompt for ${input.task}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "beta" },
      runName: "command-agent-prompt-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: { local: { binary: "local-agent" } },
        workingAgents: { small: [{ provider: "local" }] },
        interactiveAgents: {},
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
    expect(promptFileBeforeRun).toBe(join(result.runDir, "steps", "review", "prompt.md"));
    expect(promptTextBeforeRun).toContain("Original prompt for beta.");
    expect(promptTextBeforeRun).toContain("write exactly one JSON object");
    expect(promptTextBeforeRun).toContain(join(result.runDir, "steps", "review", "output.json"));
    expect(promptTextBeforeRun).toContain('"answer"');
  });
});

describe("registry-vs-customAgents dispatch split", () => {
  it("dispatches a working target whose provider matches a registry key through the built-in provider, with no customAgents entry required", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-registry-dispatch-"));
    const providerCalls: ProviderWorkingProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "registry-dispatch-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small", thinking: "medium" } },
      start(input) {
        return step(
          {
            id: "greet",
            input,
            outputShape: { greeting: "string" },
            agent: "writer",
            prompt: ({ input }) => `Greet ${input.name}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Ada" },
      runName: "registry-dispatch-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {},
        workingAgents: { small: [{ provider: "claude", model: "sonnet" }] },
        interactiveAgents: {},
      }),
      providerWorkingRunner: async (request) => {
        providerCalls.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: '{"greeting":"Hello, Ada!"}' }),
        };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ greeting: "Hello, Ada!" });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      command: "claude",
      args: expect.arrayContaining(["--model", "sonnet", "--effort", "medium"]),
      cwd: result.runDir,
    });
  });

  it("dispatches a codex working target through the built-in provider using direct -o file capture, with no envelope stdout parsing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-registry-dispatch-codex-"));
    const providerCalls: ProviderWorkingProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "registry-dispatch-codex-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small", thinking: "medium" } },
      start(input) {
        return step(
          {
            id: "greet",
            input,
            outputShape: { greeting: "string" },
            agent: "writer",
            prompt: ({ input }) => `Greet ${input.name}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Dee" },
      runName: "registry-dispatch-codex-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {},
        workingAgents: { small: [{ provider: "codex", model: "gpt-5.5" }] },
        interactiveAgents: {},
      }),
      // Unlike the claude registry test above, this mock never returns a
      // stdout envelope: it writes outputFile directly, exactly as the real
      // `codex exec -o <outputFile>` process does as a side effect, and
      // returns only an exit code (stdout is unused for codex).
      providerWorkingRunner: async (request) => {
        providerCalls.push(request);
        await writeFile(request.args.at(-2) ?? "", JSON.stringify({ greeting: "Hello, Dee!" }), {
          encoding: "utf8",
        });
        return { exitCode: 0, stdout: "" };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ greeting: "Hello, Dee!" });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      command: "codex",
      args: expect.arrayContaining([
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        "gpt-5.5",
        "-c",
        'model_reasoning_effort="medium"',
      ]),
      cwd: result.runDir,
    });
    expect(providerCalls[0]?.args).toContain("-o");
  });

  it("dispatches a pi working target through the built-in provider, extracting its message-shaped envelope field", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-registry-dispatch-pi-"));
    const providerCalls: ProviderWorkingProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "registry-dispatch-pi-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small", thinking: "high" } },
      start(input) {
        return step(
          {
            id: "greet",
            input,
            outputShape: { greeting: "string" },
            agent: "writer",
            prompt: ({ input }) => `Greet ${input.name}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Pip" },
      runName: "registry-dispatch-pi-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {},
        workingAgents: { small: [{ provider: "pi", model: "openai-codex/gpt-5.5" }] },
        interactiveAgents: {},
      }),
      // Simulates the real, empirically confirmed `pi --mode json` shape: a
      // JSON-lines transcript whose final usable "message" field is a
      // message-object with a content-block array (not a flat string like
      // Claude's "result"), proving envelope.ts's field-name parameterization
      // genuinely varies per vendor.
      providerWorkingRunner: async (request) => {
        providerCalls.push(request);
        const stdout = [
          JSON.stringify({ type: "session", id: "abc" }),
          JSON.stringify({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "" },
                { type: "text", text: '{"greeting":"Hello, Pip!"}' },
              ],
            },
          }),
          JSON.stringify({ type: "agent_end", messages: [] }),
          JSON.stringify({ type: "agent_settled" }),
        ].join("\n");
        return { exitCode: 0, stdout };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ greeting: "Hello, Pip!" });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      command: "pi",
      args: expect.arrayContaining(["-p", "--model", "openai-codex/gpt-5.5", "--thinking", "high"]),
      cwd: result.runDir,
    });
    expect(providerCalls[0]?.args).toEqual(expect.arrayContaining(["--mode", "json"]));
  });

  it("dispatches a gemini working target through the built-in provider, using an injected fake runner (structural-only: the real gemini CLI is not installed here)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-registry-dispatch-gemini-"));
    const providerCalls: ProviderWorkingProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "registry-dispatch-gemini-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small", thinking: "medium" } },
      start(input) {
        return step(
          {
            id: "greet",
            input,
            outputShape: { greeting: "string" },
            agent: "writer",
            prompt: ({ input }) => `Greet ${input.name}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Gigi" },
      runName: "registry-dispatch-gemini-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: {},
        workingAgents: { small: [{ provider: "gemini", model: "gemini-2.5-pro" }] },
        interactiveAgents: {},
      }),
      // Synthetic stdout shaped like the Gemini CLI's documented
      // `--output-format json` envelope (a flat "response" string field plus
      // a "stats" object). Gemini is not installed in this environment, so
      // this is a structural stub, not a live-process fixture the way the
      // Claude/Codex/Pi dispatch tests above are.
      providerWorkingRunner: async (request) => {
        providerCalls.push(request);
        const stdout = JSON.stringify({
          response: '{"greeting":"Hello, Gigi!"}',
          stats: { models: {}, tools: {} },
        });
        return { exitCode: 0, stdout };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ greeting: "Hello, Gigi!" });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      command: "gemini",
      args: expect.arrayContaining(["-p", "--yolo", "-m", "gemini-2.5-pro"]),
      cwd: result.runDir,
    });
    expect(providerCalls[0]?.args).toEqual(expect.arrayContaining(["--output-format", "json"]));
  });

  it("prefers the registry over a same-named customAgents entry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-registry-priority-"));
    const providerCalls: ProviderWorkingProcessRequest[] = [];
    const legacyRequests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "registry-priority-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small" } },
      start(input) {
        return step(
          {
            id: "greet",
            input,
            outputShape: { greeting: "string" },
            agent: "writer",
            prompt: ({ input }) => `Greet ${input.name}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Bea" },
      runName: "registry-priority-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: { claude: { binary: "should-not-run" } },
        workingAgents: { small: [{ provider: "claude" }] },
        interactiveAgents: {},
      }),
      providerWorkingRunner: async (request) => {
        providerCalls.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: '{"greeting":"Hello, Bea!"}' }),
        };
      },
      workingAgentProcessRunner: async (request) => {
        legacyRequests.push(request);
        return { exitCode: 1 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ greeting: "Hello, Bea!" });
    expect(providerCalls).toHaveLength(1);
    expect(legacyRequests).toHaveLength(0);
  });

  it("still dispatches a provider name that is only a customAgents key through the legacy command path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-customagents-fallback-"));
    const legacyRequests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ name: string }, { greeting: string }> = {
      id: "customagents-fallback-workflow",
      inputShape: { name: "string" },
      outputShape: { greeting: "string" },
      agents: { writer: { size: "small" } },
      start(input) {
        return step(
          {
            id: "greet",
            input,
            outputShape: { greeting: "string" },
            agent: "writer",
            prompt: ({ input }) => `Greet ${input.name}.`,
          },
          (output) => done(output),
        );
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { name: "Cy" },
      runName: "customagents-fallback-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customAgents: { "local-cli": { binary: "local-cli" } },
        workingAgents: { small: [{ provider: "local-cli" }] },
        interactiveAgents: {},
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

  it("rejects a target whose provider matches neither the registry nor customAgents with agent_provider_unknown", () => {
    expect(() =>
      parseStepKitConfig({
        version: 1,
        customAgents: {},
        workingAgents: { small: [{ provider: "totally-unknown-provider" }] },
        interactiveAgents: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({ code: "agent_provider_unknown" }),
      }),
    );
  });
});
