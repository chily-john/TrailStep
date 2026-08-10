import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AgentAdapter,
  done,
  jsonSchema,
  runWorkflow,
  step,
  subPrompt,
  type Workflow,
} from "../../index.js";

const subPromptShape = jsonSchema<{ answer: string }>({
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
});

const workflowOutputShape = jsonSchema<{ final: string }>({
  type: "object",
  properties: { final: { type: "string" } },
  required: ["final"],
  additionalProperties: false,
});

describe("subPrompt resume replay", () => {
  it("reuses completed subPrompt output from events while replaying a completed step", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-sub-prompt-replay-"));
    let adapterInvocations = 0;
    let shouldFailSecondStep = true;

    const adapter: AgentAdapter<{ topic: string }, { answer: string }> = async (request) => {
      adapterInvocations += 1;
      await request.tools
        .find((tool) => tool.name === "submit_output")
        ?.call({
          answer: `chosen-${request.input.topic}`,
        });
    };

    const workflow = createSubPromptResumeWorkflow({
      adapter,
      shouldFailSecondStep: () => shouldFailSecondStep,
      renderPrompt: ({ topic }) => `Choose ${topic}`,
    });

    const failed = await runWorkflow({
      workflow,
      input: { topic: "alpha" },
      runName: "sub-prompt-replay",
      cwd,
    });

    expect(failed.status).toBe("failure");
    expect(adapterInvocations).toBe(1);
    expect(failed.events.filter((event) => event.type === "subPrompt.completed")).toHaveLength(1);

    const completed = failed.events.find((event) => event.type === "subPrompt.completed");
    const artifactPaths = completed?.payload.artifactPaths as
      | { readonly outputFile?: unknown }
      | undefined;
    const outputFile = artifactPaths?.outputFile;
    if (typeof outputFile !== "string") {
      throw new Error("Expected completed subPrompt event to include an output artifact path.");
    }
    await rm(join(failed.runDir, outputFile));

    shouldFailSecondStep = false;
    const resumed = await runWorkflow({ workflow, resume: { runDir: failed.runDir } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }

    expect(resumed.output).toEqual({ final: "chosen-alpha" });
    expect(adapterInvocations).toBe(1);
    expect(resumed.events.filter((event) => event.type === "subPrompt.started")).toHaveLength(1);
    expect(resumed.events.filter((event) => event.type === "subPrompt.completed")).toHaveLength(1);
  });

  it("redispatches when a completed subPrompt ordinal has a fingerprint mismatch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-sub-prompt-replay-"));
    let adapterInvocations = 0;
    let shouldFailSecondStep = true;
    let promptVersion = "first";

    const adapter: AgentAdapter<{ topic: string }, { answer: string }> = async (request) => {
      adapterInvocations += 1;
      await request.tools
        .find((tool) => tool.name === "submit_output")
        ?.call({
          answer: `${request.messages[0]?.content}:${adapterInvocations}`,
        });
    };

    const workflow = createSubPromptResumeWorkflow({
      adapter,
      shouldFailSecondStep: () => shouldFailSecondStep,
      renderPrompt: ({ topic }) => `Choose ${topic} ${promptVersion}`,
    });

    const failed = await runWorkflow({
      workflow,
      input: { topic: "alpha" },
      runName: "sub-prompt-fingerprint-mismatch",
      cwd,
    });

    expect(failed.status).toBe("failure");
    expect(adapterInvocations).toBe(1);

    promptVersion = "second";
    shouldFailSecondStep = false;
    const resumed = await runWorkflow({ workflow, resume: { runDir: failed.runDir } });

    expect(resumed.status).toBe("success");
    if (resumed.status !== "success") {
      throw new Error(resumed.failure.message);
    }

    expect(adapterInvocations).toBe(2);
    expect(resumed.output).toEqual({ final: "Choose alpha second:2" });
    expect(resumed.events.filter((event) => event.type === "subPrompt.started")).toHaveLength(2);
    expect(resumed.events.filter((event) => event.type === "subPrompt.completed")).toHaveLength(2);
  });
});

function createSubPromptResumeWorkflow(options: {
  readonly adapter: AgentAdapter<{ topic: string }, { answer: string }>;
  readonly shouldFailSecondStep: () => boolean;
  readonly renderPrompt: (input: { topic: string }) => string;
}): Workflow<{ topic: string }, { final: string }> {
  const secondStep = step({ id: "second" }).do(({ answer }: { answer: string }) => {
    if (options.shouldFailSecondStep()) {
      throw new Error("second step unavailable");
    }

    return done({ final: answer });
  });

  const firstStep = step({ id: "first" }).do(async (input: { topic: string }) => {
    const ask = subPrompt<{ topic: string }, { answer: string }>(
      ({ input }) => options.renderPrompt(input),
      {
        output: subPromptShape,
        adapter: options.adapter,
        agent: "helper",
      },
    );
    const output = await ask(input);
    return secondStep(output);
  });

  return {
    id: "sub-prompt-replay-workflow",
    inputShape: { topic: "string" },
    outputShape: workflowOutputShape,
    agents: { helper: { size: "small" } },
    start(input) {
      return firstStep(input);
    },
  };
}
