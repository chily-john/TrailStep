import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { done, type Event, runWorkflow, step, type Workflow } from "../index.js";

describe("runWorkflow", () => {
  it("branches to the next continuation step based on validated output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));

    const workflow: Workflow<{ shouldReview: boolean }, { destination: string }> = {
      id: "branching-workflow",
      inputShape: { shouldReview: "boolean" },
      outputShape: { destination: "string" },
      start(input) {
        return step(
          {
            id: "implementation",
            input,
            outputShape: { destination: "string" },
            run: ({ shouldReview }) => ({
              destination: shouldReview ? "review" : "failure",
            }),
          },
          (output) =>
            step(
              {
                id: output.destination,
                input: output,
                outputShape: { destination: "string" },
                run: ({ destination }) => ({ destination: `${destination}-complete` }),
              },
              done,
            ),
        );
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
        return step(
          {
            id: "review",
            input,
            outputShape: { approved: "boolean" },
            prompt: ({ input }) => `Review ${input.path}.`,
            agent: "missing-reviewer",
          },
          done,
        );
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

  it("runs a continuation workflow from start through a code step to done", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-runtime-"));

    const workflow: Workflow<{ value: number }, { value: number }> = {
      id: "math-workflow",
      inputShape: { value: "number" },
      outputShape: { value: "number" },
      start(input) {
        return step(
          {
            id: "increment",
            input,
            outputShape: { value: "number" },
            run: ({ value }) => ({ value: value + 1 }),
          },
          (output) => done({ value: output.value * 2 }),
        );
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
