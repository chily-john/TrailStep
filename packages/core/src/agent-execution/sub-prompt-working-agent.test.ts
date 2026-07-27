import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  done,
  parseStepKitConfig,
  runWorkflow,
  step,
  subPrompt,
  type Workflow,
  type WorkingAgentProcessRequest,
} from "../index.js";

describe("subPrompt configured working agent dispatch", () => {
  it("fails with subPrompt parent-step diagnostics when config is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-missing-config-"));

    const workflow: Workflow<{ topic: string }, { final: string }> = {
      id: "sub-prompt-missing-config-workflow",
      inputShape: { topic: "string" },
      outputShape: { final: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "orchestrate" }).do(async () => {
          const review = await subPrompt("Review alpha", {
            output: { answer: "string" },
            agent: "reviewer",
          })({});

          return done({ final: `${input.topic}:${review.answer}` });
        })(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { topic: "alpha" },
      runName: "sub-prompt-missing-config-run",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected missing config to fail.");
    }

    expect(result.failure).toMatchObject({
      code: "missing_agent_config",
      message: expect.stringContaining("parent step orchestrate subPrompt orchestrate.subPrompt.1"),
      details: {
        workflowId: "sub-prompt-missing-config-workflow",
        parentStepId: "orchestrate",
        subPromptId: "orchestrate.subPrompt.1",
        agent: "reviewer",
        mode: "working",
      },
    });
  });

  it("runs a subPrompt through a configured working agent and validates output.json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-sub-prompt-working-agent-"));
    const requests: WorkingAgentProcessRequest[] = [];

    const workflow: Workflow<{ topic: string }, { final: string }> = {
      id: "sub-prompt-working-agent-workflow",
      inputShape: { topic: "string" },
      outputShape: { final: "string" },
      agents: { reviewer: { size: "medium" } },
      start(input) {
        return step({ id: "orchestrate" }).do(async () => {
          const review = await subPrompt("Review alpha", {
            output: { answer: "string" },
            agent: "reviewer",
          })({});

          return done({ final: `${input.topic}:${review.answer}` });
        })(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { topic: "alpha" },
      runName: "sub-prompt-working-agent-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customProviders: {
          local: { binary: "local-agent" },
        },
        agents: { medium: [{ provider: "local", model: "review-model" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        requests.push(request);
        expect(request.promptFile).toContain("subPrompts");
        expect(request.promptFile).toMatch(/prompt\.txt$/);
        expect(request.outputFile).toContain("subPrompts");
        expect(request.outputFile).toMatch(/output\.json$/);
        await writeFile(request.outputFile, JSON.stringify({ answer: "accepted" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ final: "alpha:accepted" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "local-agent",
      model: "review-model",
      cwd,
    });

    const started = result.events.find((event) => event.type === "subPrompt.started");
    const artifactPaths = started?.payload.artifactPaths as {
      readonly promptFile: string;
      readonly outputFile: string;
    };

    expect(artifactPaths.promptFile).toMatch(
      /^steps\/0001-orchestrate\/subPrompts\/0001-[^/]+\/prompt\.txt$/,
    );
    expect(artifactPaths.outputFile).toMatch(
      /^steps\/0001-orchestrate\/subPrompts\/0001-[^/]+\/output\.json$/,
    );
    await expect(
      readFile(join(result.runDir, artifactPaths.promptFile), "utf8"),
    ).resolves.toContain("Review alpha");
    await expect(
      JSON.parse(await readFile(join(result.runDir, artifactPaths.outputFile), "utf8")),
    ).toEqual({
      answer: "accepted",
    });
  });
});
