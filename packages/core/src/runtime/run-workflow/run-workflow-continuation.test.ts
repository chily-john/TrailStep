import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  document,
  done,
  type Event,
  parseStepKitConfig,
  runWorkflow,
  state,
  step,
  type Workflow,
} from "../../index.js";

describe("runWorkflow", () => {
  it("branches to the next continuation step based on validated output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));

    const workflow: Workflow<{ shouldReview: boolean }, { destination: string }> = {
      id: "branching-workflow",
      inputShape: { shouldReview: "boolean" },
      outputShape: { destination: "string" },
      start(input) {
        return step({ id: "implementation" }).do((stepInput) => {
          const output = {
            destination: stepInput.shouldReview ? "review" : "failure",
          };
          return step({
            id: output.destination,
          }).do((nextInput) => done({ destination: `${nextInput.destination}-complete` }))(output);
        })(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { shouldReview: true },
      runName: "branching-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ destination: "review-complete" });
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(result.events[1]?.stepId).toBe("implementation");
    expect(result.events[3]?.stepId).toBe("review");
  });

  it("fails when a continuation step references an undeclared workflow agent role", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));

    const workflow: Workflow<{ path: string }, { approved: boolean }> = {
      id: "portable-review",
      agents: {
        reviewer: { description: "Reviews generated output.", size: "small" },
      },
      inputShape: { path: "string" },
      outputShape: { approved: "boolean" },
      start(input) {
        return step({
          id: "review",
        })
          .prompt(({ input }) => `Review ${input.path}.`, {
            output: { approved: "boolean" },
            agent: "missing-reviewer",
          })
          .do(done)(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { path: "README.md" },
      runName: "unknown-agent-role",
      cwd,
    });

    expect(result.status).toBe("failure");
    if (result.status !== "failure") {
      throw new Error("Expected workflow to fail for an unknown agent role.");
    }

    expect(result.failure).toMatchObject({
      code: "agent_role_unknown",
    });
    expect(result.failure.message).toContain("missing-reviewer");
    expect(result.failure.message).toContain("portable-review");
  });

  it("passes durable ambient state to orchestration step continuations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));

    const rememberStep = step({ id: "remember" }).do(async (input: { value: number }) => {
      await state.set("count", { value: input.value });
      return recallStep(input);
    });

    const recallStep = step({ id: "recall" }).do(async () => {
      const stored = await state.get("count");
      return done(stored as { value: number });
    });

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "stateful-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return rememberStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 3 },
      runName: "durable-state",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ value: 3 });
    await expect(readFile(join(result.runDir, "state.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ count: { value: 3 } }, null, 2)}\n`,
    );
  });

  it("persists step events before the event sink observes a later event", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));
    let eventsAtFirstStepCompletion: readonly Event[] = [];

    const firstStep = step({ id: "first" }).do((input: { value: number }) =>
      secondStep({ value: input.value + 1 }),
    );

    const secondStep = step({ id: "second" }).do((input: { value: number }) =>
      done({ value: input.value + 1 }),
    );

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "incremental-events",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return firstStep(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "incremental-events-run",
      cwd,
      eventSink: async (event) => {
        if (event.type !== "step.completed" || event.stepId !== "first") {
          return;
        }

        try {
          const contents = await readFile(
            join(cwd, ".stepkit", "runs", event.runId, "events.jsonl"),
            "utf8",
          );
          eventsAtFirstStepCompletion = contents
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Event);
        } catch {
          eventsAtFirstStepCompletion = [];
        }
      },
    });

    expect(result.status).toBe("success");
    expect(eventsAtFirstStepCompletion.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
    ]);
    expect(eventsAtFirstStepCompletion[2]?.stepId).toBe("first");
  });

  it("appends workflow.failed through the same emit path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));
    let eventsAtWorkflowFailure: readonly Event[] = [];

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "failed-incremental-events",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step({ id: "explode" }).do(() => {
          throw new Error("boom");
        })(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 1 },
      runName: "failed-incremental-events-run",
      cwd,
      eventSink: async (event) => {
        if (event.type !== "workflow.failed") {
          return;
        }

        try {
          const contents = await readFile(
            join(cwd, ".stepkit", "runs", event.runId, "events.jsonl"),
            "utf8",
          );
          eventsAtWorkflowFailure = contents
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Event);
        } catch {
          eventsAtWorkflowFailure = [];
        }
      },
    });

    expect(result.status).toBe("failure");
    expect(eventsAtWorkflowFailure.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.failed",
      "workflow.failed",
    ]);
  });

  it("runs a continuation workflow from start through a code step to done", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "math-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step({ id: "increment" }).do((stepInput: { value: number }) =>
          done({ value: (stepInput.value + 1) * 2 }),
        )(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { value: 2 },
      runName: "my-run",
      cwd,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error(result.failure.message);
    }

    expect(result.output).toEqual({ value: 6 });
    expect(result.runId).toBe("my-run");
    expect(result.runDir).toBe(join(cwd, ".stepkit", "runs", "my-run"));
    expect(result.events.map((event) => event.type)).toEqual([
      "workflow.started",
      "step.started",
      "step.completed",
      "workflow.completed",
    ]);
    expect(result.events.every(hasV0Envelope)).toBe(true);

    const eventsJsonl = await readFile(join(result.runDir, "events.jsonl"), "utf8");
    const persistedEvents = eventsJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event);

    expect(persistedEvents.map((event) => event.type)).toEqual(
      result.events.map((event) => event.type),
    );
    expect(persistedEvents[1]?.stepId).toBe("increment");
  });

  it("runs a prompt step whose output is document(...), delivering a Document to .do(...)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-document-"));

    const workflow: Workflow<{ topic: string }, { name: string; content: string }> = {
      id: "document-workflow",
      inputShape: { topic: "string" },
      outputShape: { name: "string", content: "string" },
      agents: { writer: { size: "medium" } },
      start(input) {
        return step({ id: "draft" })
          .prompt(({ input }) => `Draft notes about ${input.topic}.`, {
            output: document("draft"),
            agent: "writer",
          })
          .do((doc) => done({ name: doc.name, content: doc.content }))(input);
      },
    };

    const result = await runWorkflow({
      workflow,
      input: { topic: "continuations" },
      runName: "document-run",
      cwd,
      stepkitConfig: parseStepKitConfig({
        version: 1,
        customProviders: { worker: { binary: "worker-agent" } },
        agents: { medium: [{ provider: "worker" }] },
      }),
      workingAgentProcessRunner: async (request) => {
        await writeFile(
          request.outputFile,
          "# Draft\n\nFree-form prose about continuations, not JSON.",
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
      name: "draft",
      content: "# Draft\n\nFree-form prose about continuations, not JSON.",
    });

    const documentPath = join(result.runDir, "documents", "draft.md");
    await expect(readFile(documentPath, "utf8")).resolves.toBe(
      "# Draft\n\nFree-form prose about continuations, not JSON.",
    );
  });
});

function hasV0Envelope(event: Event): boolean {
  return (
    typeof event.id === "string" &&
    event.id.length > 0 &&
    typeof event.runId === "string" &&
    event.runId.length > 0 &&
    event.workflowId === "math-workflow" &&
    typeof event.timestamp === "string" &&
    event.schemaVersion === "v0" &&
    typeof event.payload === "object" &&
    event.payload !== null
  );
}
