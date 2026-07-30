import { readFile } from "node:fs/promises";

import { document } from "../../../authoring/document/document.js";
import type { AgentStepRequestConfig } from "../../../authoring/step/agent-step.types.js";
import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";

export async function readWorkingAgentOutput<TOutput extends PlainObject>(options: {
  readonly stepId: string;
  readonly outputFile: string;
  readonly step: AgentStepRequestConfig<PlainObject, TOutput>;
}): Promise<TOutput> {
  let raw: string;
  try {
    raw = await readFile(options.outputFile, "utf8");
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_output_unreadable",
      message: `Working agent step ${options.stepId} output.json could not be read.`,
      details:
        error instanceof Error
          ? { path: options.outputFile, cause: error.message }
          : { path: options.outputFile },
    });
  }

  if (options.step.output.captureMode === "raw-text") {
    // Delegates to the shared `document(...)` capture path (the same one
    // code-authored steps use), so agent-captured and code-captured
    // documents share one persistence implementation. `document(...)`
    // resolves its target directory and index from the ambient step
    // context (`currentStep`), which is active for the whole duration of
    // this step's dispatch (see `withStepContext` in run-continuation.ts).
    const capturedDocument = await document(raw);

    return options.step.output.assert(capturedDocument, `step ${options.stepId} output`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StepKitFailureError({
      code: "agent_output_invalid_json",
      message: `Working agent step ${options.stepId} output.json must contain one JSON object.`,
      details:
        error instanceof Error
          ? { path: options.outputFile, cause: error.message }
          : { path: options.outputFile },
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StepKitFailureError({
      code: "agent_output_invalid_json",
      message: `Working agent step ${options.stepId} output.json must contain one JSON object.`,
      details: { path: options.outputFile },
    });
  }

  return options.step.output.assert(parsed, `step ${options.stepId} output`);
}
