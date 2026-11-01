import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ContinuationResult,
  StepNode,
  StepPhase,
} from "../../../authoring/step/continuation.types.js";
import {
  done,
  type Event,
  type PlainObject,
  TrailStepFailureError,
  type Workflow,
} from "../../../index.js";
import { createEvent } from "../../events/create-run-event.js";
import { replayCompletedSteps } from "./replay-completed-steps.js";

const RUN_ID = "replay-integrity-run";
const WORKFLOW_ID = "replay-integrity-workflow";

/**
 * Phase fixtures that are deliberately buildable only by hand: the fluent
 * `step(...)` builder always appends a `do` phase last, so "a do phase in the
 * middle" / "no do phase at all" — the shapes replay must refuse — can only be
 * produced by constructing a `StepNode` directly.
 */
const PROMPT_PHASE: StepPhase = {
  kind: "prompt",
  prompt: "Produce a value.",
  output: { value: "string" },
};

const DO_PHASE: StepPhase = {
  kind: "do",
  onOutput: () => done({ value: "replayed" }),
};

function replayStepNode(id: string, phases: readonly StepPhase[]): StepNode {
  return {
    kind: "step",
    config: { id, input: {} },
    phases,
    onOutput: () => done({ value: "unused" }),
  };
}

function workflowStartingAt(
  node: ContinuationResult,
): Workflow<Record<string, never>, PlainObject> {
  return {
    id: WORKFLOW_ID,
    start() {
      return node;
    },
  };
}

function completedStepEvents(stepId: string, output: PlainObject = { value: "recorded" }): Event[] {
  return [
    createEvent({
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      stepId,
      type: "step.started",
      payload: { stepName: stepId },
    }),
    createEvent({
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      stepId,
      type: "step.completed",
      payload: { output },
    }),
  ];
}

function readHint(error: TrailStepFailureError): string | undefined {
  const details = error.failure.details;
  if (typeof details !== "object" || details === null || !("hint" in details)) {
    return undefined;
  }

  const hint = (details as { readonly hint?: unknown }).hint;
  return typeof hint === "string" ? hint : undefined;
}

async function expectReplayFailure(options: {
  readonly stepId: string;
  readonly phases: readonly StepPhase[];
}): Promise<TrailStepFailureError> {
  const runDir = await mkdtemp(join(tmpdir(), "trailstep-core-replay-integrity-"));

  try {
    await replayCompletedSteps({
      workflow: workflowStartingAt(replayStepNode(options.stepId, options.phases)),
      events: completedStepEvents(options.stepId),
      input: {},
      targetStepId: options.stepId,
      runDir,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(TrailStepFailureError);
    return error as TrailStepFailureError;
  }

  throw new Error("expected resume replay to refuse this step shape");
}

describe("replayCompletedSteps integrity failures", () => {
  it("reports executable phases after a do phase with a structured failure", async () => {
    const error = await expectReplayFailure({
      stepId: "phase-order-step",
      phases: [PROMPT_PHASE, DO_PHASE, PROMPT_PHASE],
    });

    expect(error.failure.code).toBe("resume_replay_invalid_phase_order");
    expect(error.failure.message).toContain("executable phases after a do phase");
    expect(error.failure.details).toMatchObject({ stepId: "phase-order-step" });
    expect(readHint(error)).toBeTruthy();
  });

  it("reports a missing recorded prompt output with a structured failure", async () => {
    const error = await expectReplayFailure({
      stepId: "missing-output-step",
      phases: [PROMPT_PHASE, PROMPT_PHASE, DO_PHASE],
    });

    expect(error.failure.code).toBe("resume_replay_missing_step_output");
    expect(error.failure.message).toContain("no recorded output");
    expect(error.failure.details).toMatchObject({ stepId: "missing-output-step" });
    expect(readHint(error)).toBeTruthy();
  });

  it("reports a step without a do phase with a structured failure", async () => {
    const error = await expectReplayFailure({
      stepId: "missing-do-step",
      phases: [PROMPT_PHASE],
    });

    expect(error.failure.code).toBe("resume_replay_missing_do_phase");
    expect(error.failure.message).toContain("no do phase");
    expect(error.failure.details).toMatchObject({ stepId: "missing-do-step" });
    expect(readHint(error)).toBeTruthy();
  });
});
