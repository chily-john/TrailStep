import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  done,
  type InteractiveProcessRunner,
  jsonSchema,
  runWorkflow,
  step,
  type Workflow,
} from "../../index.js";
import { resolveStepArtifactPaths } from "../../runtime/artifacts/step-artifacts.js";
import { runInteractiveAgentCommand } from "./run-interactive-agent-command.js";

describe("continuation interactive agent roles", () => {
  it("sets TRAILSTEP_INTERACTIVE_FILE for interactive processes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-env-"));
    const runDir = join(cwd, ".trailstep", "runs", "interactive-env-run");
    const artifactPaths = resolveStepArtifactPaths({ runDir, stepId: "review", stepIndex: 1 });
    const result = await runInteractiveAgentCommand({
      config: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      workflowId: "interactive-env-workflow",
      roleName: "reviewer",
      role: { size: "small" },
      stepId: "review",
      renderedPrompt: "Review environment handling.",
      runDir,
      outputSchema: jsonSchema({
        type: "object",
        properties: { notes: { type: "string" } },
        required: ["notes"],
        additionalProperties: false,
      }),
      artifactPaths,
      outputMode: "json",
      runner: async (call) => {
        expect(call.env?.TRAILSTEP_INTERACTIVE_FILE).toBe(artifactPaths.interactiveFile);
        const protocol = JSON.parse(await readFile(artifactPaths.interactiveFile, "utf8"));
        await writeFile(
          protocol.outputFile,
          `${JSON.stringify({ notes: "TrailStep env only." }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          artifactPaths.interactiveFile,
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.output).toEqual({ notes: "TrailStep env only." });
  });

  it("passes custom structured interactive output into the continuation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-json-"));
    const workflow: Workflow<{ task: string }, { notes: string }> = {
      id: "interactive-json-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: {
        reviewer: { description: "Reviews plans.", size: "small" },
      },
      start(input) {
        return step({
          id: "approve-plan",
        })
          .prompt(({ input }) => `Approve ${input.task}?`, {
            output: { approved: "boolean", notes: "string" },
            agent: "reviewer",
            mode: "interactive",
          })
          .do(({ approved, notes }) => done({ notes: approved ? notes : "Denied." }))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "interactive updates" },
      runName: "interactive-json-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: {
          small: [{ provider: "terminalAgent", model: "right-mode" }],
        },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
        const protocol = JSON.parse(await readFile(interactiveFile ?? "", "utf8"));
        expect(protocol.outputMode).toBe("json");
        expect(protocol.outputSchema).toMatchObject({
          properties: { approved: { type: "boolean" }, notes: { type: "string" } },
          required: ["approved", "notes"],
          additionalProperties: false,
        });
        expect(protocol.sessionDescriptionFile).toBeUndefined();
        await writeFile(
          protocol.outputFile,
          `${JSON.stringify({ approved: true, notes: "Approved." }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          interactiveFile ?? "",
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ notes: "Approved." });
    await expect(
      readFile(join(result.runDir, "steps", "0001-approve-plan", "prompt.txt"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("trailstep continue --json"));
    await expect(
      readFile(join(result.runDir, "steps", "0001-approve-plan", "prompt.txt"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("trailstep continue --json-file output.json"));
    await expect(
      readFile(join(result.runDir, "steps", "0001-approve-plan", "prompt.txt"), "utf8"),
    ).resolves.toEqual(expect.stringContaining('"approved"'));
    await expect(
      readFile(join(result.runDir, "steps", "0001-approve-plan", "prompt.txt"), "utf8"),
    ).resolves.toEqual(expect.stringContaining("If validation fails"));
  });

  it("uses global step order for repeated interactive step ids", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-ordered-"));
    const stepDirs: string[] = [];
    const workflow: Workflow<{ task: string }, { notes: string }> = {
      id: "interactive-ordered-artifacts-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: {
        reviewer: { size: "small" },
      },
      start(input) {
        return step({ id: "prepare" }).do(() =>
          step({
            id: "review",
          })
            .prompt(({ input }) => `First review for ${input.task}.`, {
              output: { notes: "string" },
              agent: "reviewer",
              mode: "interactive",
            })
            .do((first) =>
              step({ id: "record" }).do(() =>
                step({
                  id: "review",
                })
                  .prompt("Second review.", {
                    output: { notes: "string" },
                    agent: "reviewer",
                    mode: "interactive",
                  })
                  .do((second) => done({ notes: `${first.notes}/${second.notes}` }))({}),
              )(first),
            )({ task: input.task }),
        )(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "repeat" },
      runName: "interactive-ordered-artifacts-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
        const protocol = JSON.parse(await readFile(interactiveFile ?? "", "utf8"));
        stepDirs.push(protocol.runRelativeStepDir);
        await writeFile(
          protocol.outputFile,
          `${JSON.stringify({ notes: protocol.runRelativeStepDir.includes("0002") ? "first" : "second" }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          interactiveFile ?? "",
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(stepDirs).toEqual(["steps/0002-review", "steps/0004-review"]);
    await expect(
      readFile(join(result.runDir, "steps", "0002-review", "interactive.json"), "utf8"),
    ).resolves.toContain('"stepId": "review"');
    await expect(
      readFile(join(result.runDir, "steps", "0004-review", "output.json"), "utf8"),
    ).resolves.toContain("second");
    expect(
      result.events.filter((event) => event.type === "step.started").map((event) => event.stepId),
    ).toEqual(["prepare", "review", "record", "review"]);
  });

  it("continues when completion is marked before the interactive process exits and aborts the runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-completion-wins-"));
    let aborted = false;
    const workflow: Workflow<{ task: string }, { notes: string }> = {
      id: "interactive-completion-wins-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { notes: "string" },
            agent: "reviewer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "cancellation" },
      runName: "interactive-completion-wins-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
        expect(call.signal).toBeDefined();
        await completeInteractive(call, { notes: "Completed from another terminal." });
        await new Promise<void>((resolve) => {
          call.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
          void delay(250).then(resolve);
        });
        expect(interactiveFile).toBeTruthy();
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ notes: "Completed from another terminal." });
    expect(aborted).toBe(true);
  });

  it("fails when the interactive process exits before completion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-incomplete-"));
    const workflow: Workflow<{ task: string }, { notes: string }> = {
      id: "interactive-incomplete-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { notes: "string" },
            agent: "reviewer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "safety" },
      runName: "interactive-incomplete-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async () => ({ exitCode: 0 }),
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected workflow to fail.");
    }
    expect(result.failure.code).toBe("interactive_session_incomplete");
    expect(result.failure.message).toMatch(/did not complete/i);
  });

  it("fails when the interactive session is cancelled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-cancelled-"));
    const workflow: Workflow<{ task: string }, { notes: string }> = {
      id: "interactive-cancelled-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { notes: "string" },
            agent: "reviewer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "cancellation" },
      runName: "interactive-cancelled-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
        const protocol = JSON.parse(await readFile(interactiveFile ?? "", "utf8"));
        await writeFile(
          interactiveFile ?? "",
          `${JSON.stringify({ ...protocol, status: "cancelled", reason: "Requirements changed." }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected workflow to fail.");
    }
    expect(result.failure.code).toBe("interactive_session_cancelled");
    expect(result.failure.message).toMatch(/was cancelled/i);
    expect(result.failure.details).toMatchObject({ reason: "Requirements changed." });
  });

  it("fails when completion output is missing or invalid", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-output-invalid-"));
    const workflow: Workflow<{ task: string }, { approved: boolean; notes: string }> = {
      id: "interactive-output-invalid-workflow",
      inputShape: { task: "string" },
      outputShape: { approved: "boolean", notes: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { approved: "boolean", notes: "string" },
            agent: "reviewer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "safety" },
      runName: "interactive-output-invalid-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
        const protocol = JSON.parse(await readFile(interactiveFile ?? "", "utf8"));
        await writeFile(
          protocol.outputFile,
          `${JSON.stringify({ approved: true }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          interactiveFile ?? "",
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected workflow to fail.");
    }
    expect(result.failure.code).toBe("interactive_output_invalid");
    expect(result.failure.message).toMatch(/schema validation/i);
  });

  it("prepends dense session-description instructions for default interactive steps", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-dense-preamble-"));
    let prompt = "";
    const workflow: Workflow<{ task: string }, { sessionFile: string }> = {
      id: "interactive-dense-preamble-workflow",
      inputShape: { task: "string" },
      outputShape: { sessionFile: "string" },
      agents: { designer: { size: "small" } },
      start(input) {
        return step({ id: "discuss" })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            agent: "designer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "dense context" },
      runName: "interactive-dense-preamble-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{prompt}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        prompt = call.args[0] ?? "";
        await completeInteractiveWithSessionFile(call, "Dense context notes.\n");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(prompt).toContain("preserve as much usable context as possible");
    expect(prompt).toContain("describe the conversation rather than aggressively summarize");
    expect(prompt).toContain("decisions, rejected options, tradeoffs, constraints, side comments");
    expect(prompt).toContain(
      "terminology, open questions, assumptions, file paths, commands, APIs",
    );
    expect(prompt).toContain(
      "package names, examples, preferences, reasoning, and abandoned options",
    );
    expect(prompt).toContain("context preservation, not polish");
    expect(prompt).toContain("Do not omit low-importance details merely because they seem minor");
    expect(prompt).toContain("## Original prompt\nDiscuss dense context.");
    expect(prompt).not.toContain("Step directory:");
    expect(prompt).toContain("session-description.md in the current directory.");
  });

  it("renders custom interactive conditional model and thinking args", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-thinking-"));
    const workflow: Workflow<{ task: string }, { exitCode: number }> = {
      id: "interactive-thinking-workflow",
      inputShape: { task: "string" },
      outputShape: { exitCode: "number" },
      agents: { implementor: { size: "small" } },
      start(input) {
        return step({ id: "discuss" })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            output: { exitCode: "number" },
            agent: "implementor",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "template args" },
      runName: "interactive-thinking-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: {
            binary: "terminal-agent",
            interactiveArgs: [
              "--prompt",
              "{{prompt}}",
              "{{#model}}",
              "--model",
              "{{model}}",
              "{{/model}}",
              "{{#thinking}}",
              "--thinking",
              "{{thinking}}",
              "{{/thinking}}",
            ],
          },
        },
        agents: { small: [{ provider: "terminalAgent", model: "fast", thinking: "high" }] },
      },
      processRunner: async (call) => {
        expect(call.args).toEqual([
          "--prompt",
          expect.stringContaining("## Original prompt\nDiscuss template args."),
          "--model",
          "fast",
          "--thinking",
          "high",
        ]);
        await completeInteractive(call, { exitCode: 0 });
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    expect(result.output).toEqual({ exitCode: 0 });
  });

  it("does not write a prompt file when the interactive command receives the prompt directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-direct-prompt-"));
    const workflow: Workflow<{ task: string }, { sessionFile: string }> = {
      id: "interactive-direct-prompt-workflow",
      inputShape: { task: "string" },
      outputShape: { sessionFile: "string" },
      agents: { designer: { size: "small" } },
      start(input) {
        return step({ id: "discuss" })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            agent: "designer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "direct prompt" },
      runName: "interactive-direct-prompt-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["--prompt", "{{prompt}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        expect(call.args[1]).toContain("## Original prompt\nDiscuss direct prompt.");
        await completeInteractiveWithSessionFile(call, "Direct prompt notes.\n");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }
    await expect(readdir(join(result.runDir, "steps", "0001-discuss"))).resolves.not.toContain(
      "prompt.txt",
    );
  });

  it("keeps default and custom interactive artifact directories minimal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-minimal-artifacts-"));

    const defaultWorkflow: Workflow<{ task: string }, { sessionFile: string }> = {
      id: "interactive-minimal-default-workflow",
      inputShape: { task: "string" },
      outputShape: { sessionFile: "string" },
      agents: { designer: { size: "small" } },
      start(input) {
        return step({ id: "discuss" })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            agent: "designer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };
    const customWorkflow: Workflow<{ task: string }, { notes: string }> = {
      id: "interactive-minimal-custom-workflow",
      inputShape: { task: "string" },
      outputShape: { notes: "string" },
      agents: { reviewer: { size: "small" } },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.task}.`, {
            output: { notes: "string" },
            agent: "reviewer",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const defaultResult = await runWorkflow({
      workflow: defaultWorkflow,
      input: { task: "minimal default" },
      runName: "interactive-minimal-default-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{prompt}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        await completeInteractiveWithSessionFile(call, "Minimal default notes.\n");
        return { exitCode: 0 };
      },
    });
    const customResult = await runWorkflow({
      workflow: customWorkflow,
      input: { task: "minimal custom" },
      runName: "interactive-minimal-custom-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{prompt}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async (call) => {
        await completeInteractive(call, { notes: "Minimal custom notes." });
        return { exitCode: 0 };
      },
    });

    expect(defaultResult.status).toBe("success");
    expect(customResult.status).toBe("success");
    if (defaultResult.status !== "success") {
      throw new Error(defaultResult.failure.message);
    }
    if (customResult.status !== "success") {
      throw new Error(customResult.failure.message);
    }

    await expect(
      readdir(join(defaultResult.runDir, "steps", "0001-discuss")).then((files) => files.sort()),
    ).resolves.toEqual(["interactive.json", "output.json", "session-description.md"]);
    await expect(
      readdir(join(customResult.runDir, "steps", "0001-review")).then((files) => files.sort()),
    ).resolves.toEqual(["interactive.json", "output.json"]);
  });

  it("continues a default interactive step from session-file completion artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-default-"));
    const workflow: Workflow<{ task: string }, { sessionFile: string }> = {
      id: "interactive-default-workflow",
      inputShape: { task: "string" },
      outputShape: { sessionFile: "string" },
      agents: {
        designer: { description: "Designs features.", size: "small" },
      },
      start(input) {
        return step({ id: "discuss-feature" })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            agent: "designer",
            mode: "interactive",
          })
          .do(({ sessionFile }) => done({ sessionFile }))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "interactive updates" },
      runName: "interactive-default-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: {
          small: [{ provider: "terminalAgent", model: "right-mode" }],
        },
      },
      processRunner: async (call) => {
        const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
        expect(interactiveFile).toBe(
          join(
            cwd,
            ".trailstep",
            "runs",
            "interactive-default-run",
            "steps",
            "0001-discuss-feature",
            "interactive.json",
          ),
        );
        const protocol = JSON.parse(await readFile(interactiveFile ?? "", "utf8"));
        expect(protocol.stepDir).toBe(
          join(
            cwd,
            ".trailstep",
            "runs",
            "interactive-default-run",
            "steps",
            "0001-discuss-feature",
          ),
        );
        expect(protocol.runRelativeStepDir).toBe("steps/0001-discuss-feature");
        await writeFile(
          protocol.sessionDescriptionFile,
          "Discussed interactive updates.\n",
          "utf8",
        );
        await writeFile(
          protocol.outputFile,
          `${JSON.stringify({ sessionFile: "steps/0001-discuss-feature/session-description.md" }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          interactiveFile ?? "",
          `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
          "utf8",
        );
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({
      sessionFile: "steps/0001-discuss-feature/session-description.md",
    });
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "discuss-feature",
          type: "interactive.sessionStarted",
        }),
        expect.objectContaining({
          stepId: "discuss-feature",
          type: "interactive.sessionCompleted",
          payload: expect.objectContaining({
            outputMode: "session-file",
            stepDir: "steps/0001-discuss-feature",
          }),
        }),
      ]),
    );
    await expect(
      readFile(join(result.runDir, "steps", "0001-discuss-feature", "prompt.txt"), "utf8"),
    ).resolves.toContain("trailstep continue --session-file session-description.md");
  });

  it("resolves a continuation interactive agent role from the unified agents mapping", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-agent-"));
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
        })
          .prompt(({ input }) => `Implement ${input.task}.`, {
            output: { exitCode: "number" },
            agent: "implementor",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "feature" },
      runName: "interactive-agent-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          working: { binary: "working-agent", args: ["{{promptFile}}"] },
          interactive: { binary: "interactive-agent", interactiveArgs: ["{{promptFile}}"] },
        },
        agents: {
          large: [{ provider: "interactive", model: "interactive-model" }],
        },
      },
      processRunner: async (call) => {
        runnerCalls.push(call);
        await completeInteractive(call, { exitCode: 0 });
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

  it("rejects a custom interactive provider that only declares working args", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-unsupported-"));
    let runnerCalled = false;
    const workflow: Workflow<{ task: string }, { exitCode: number }> = {
      id: "interactive-unsupported-workflow",
      inputShape: { task: "string" },
      outputShape: { exitCode: "number" },
      agents: { implementor: { size: "small" } },
      start(input) {
        return step({
          id: "discuss",
        })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            output: { exitCode: "number" },
            agent: "implementor",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "unsupported provider" },
      runName: "interactive-unsupported-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: { binary: "terminal-agent", args: ["{{promptFile}}"] },
        },
        agents: { small: [{ provider: "terminalAgent" }] },
      },
      processRunner: async () => {
        runnerCalled = true;
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected unsupported interactive provider to fail.");
    }
    expect(result.failure.code).toBe("agent_provider_interactive_unsupported");
    expect(result.failure.message).toMatch(/interactiveArgs/i);
    expect(runnerCalled).toBe(false);
  });

  it("passes rendered prompt to configured interactive command without a shell", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-prompt-"));
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
        })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            output: { exitCode: "number" },
            agent: "implementor",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "prompt handoff" },
      runName: "interactive-prompt-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {
          terminalAgent: {
            binary: "terminal-agent",
            interactiveArgs: ["--message-file", "{{promptFile}}", "--literal", "&&"],
          },
        },
        agents: {
          small: [{ provider: "terminalAgent", model: "right-mode" }],
        },
      },
      processRunner: async (call) => {
        runnerCalls.push(call);
        await completeInteractive(call, { exitCode: 0 });
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    const stepDir = join(result.runDir, "steps", "0001-discuss");
    const promptFile = join(stepDir, "prompt.txt");
    expect(runnerCalls[0]).toMatchObject({
      command: "terminal-agent",
      args: ["--message-file", promptFile, "--literal", "&&"],
      cwd: stepDir,
      shell: false,
      stdio: "inherit",
    });
    await expect(readFile(promptFile, "utf8")).resolves.toContain("Discuss prompt handoff.");
  });

  it("dispatches an interactive target whose provider matches a registry key through the built-in provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-registry-"));
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
        })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            output: { exitCode: "number" },
            agent: "implementor",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "prompt handoff" },
      runName: "interactive-registry-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {},
        agents: {
          small: [{ provider: "claude", model: "opus" }],
        },
      },
      processRunner: async (call) => {
        runnerCalls.push(call);
        await completeInteractive(call, { exitCode: 0 });
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(runnerCalls).toHaveLength(1);
    const registryStepDir = join(result.runDir, "steps", "0001-discuss");
    const promptFilePath = join(registryStepDir, "prompt.txt");
    expect(runnerCalls[0]).toMatchObject({
      command: "claude",
      args: [
        "--model",
        "opus",
        "--dangerously-skip-permissions",
        "--append-system-prompt-file",
        promptFilePath,
      ],
      cwd: registryStepDir,
      shell: false,
      stdio: "inherit",
    });

    const promptFileContents = await readFile(promptFilePath, "utf8");
    expect(promptFileContents).toContain("## Original prompt\nDiscuss prompt handoff.");
  });

  it("omits --dangerously-skip-permissions when the resolved target sets permissionMode to prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-interactive-registry-"));
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
        })
          .prompt(({ input }) => `Discuss ${input.task}.`, {
            output: { exitCode: "number" },
            agent: "implementor",
            mode: "interactive",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { task: "prompt handoff" },
      runName: "interactive-registry-run",
      cwd,
      trailstepConfig: {
        version: 1,
        customProviders: {},
        agents: {
          small: [{ provider: "claude", permissionMode: "prompt" }],
        },
      },
      processRunner: async (call) => {
        runnerCalls.push(call);
        await completeInteractive(call, { exitCode: 0 });
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]?.args).not.toContain("--dangerously-skip-permissions");
  });
});

async function completeInteractiveWithSessionFile(
  call: Parameters<InteractiveProcessRunner>[0],
  sessionDescription: string,
): Promise<void> {
  const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
  if (!interactiveFile) {
    throw new Error("Expected TRAILSTEP_INTERACTIVE_FILE to be set.");
  }

  const protocol = JSON.parse(await readFile(interactiveFile, "utf8"));
  await writeFile(protocol.sessionDescriptionFile, sessionDescription, "utf8");
  await writeFile(
    protocol.outputFile,
    `${JSON.stringify({ sessionFile: protocol.runRelativeSessionDescriptionFile }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    interactiveFile,
    `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
    "utf8",
  );
}

async function completeInteractive(
  call: Parameters<InteractiveProcessRunner>[0],
  output: Record<string, unknown>,
): Promise<void> {
  const interactiveFile = call.env?.TRAILSTEP_INTERACTIVE_FILE;
  if (!interactiveFile) {
    throw new Error("Expected TRAILSTEP_INTERACTIVE_FILE to be set.");
  }

  const protocol = JSON.parse(await readFile(interactiveFile, "utf8"));
  await writeFile(protocol.outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(
    interactiveFile,
    `${JSON.stringify({ ...protocol, status: "completed" }, null, 2)}\n`,
    "utf8",
  );
}
