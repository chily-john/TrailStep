import type { StepCwdInput } from "../../../authoring/step/continuation.types.js";
import type { PlainObject } from "../../../contracts/shapes/shape.types.js";
import { runContextStorage } from "../../run-context/run-context-storage.js";
import { validateDirectoryCwd } from "../../run-workflow/cwd.js";

export async function resolveStepExecutionCwd(options: {
  readonly stepId: string;
  readonly workflowId: string;
  readonly defaultCwd: string;
  readonly input: PlainObject;
  readonly cwdInput: StepCwdInput | undefined;
}): Promise<string> {
  if (options.cwdInput === undefined) {
    return options.defaultCwd;
  }

  const cwd =
    typeof options.cwdInput === "function"
      ? await resolveStepCwdCallback(options.cwdInput, options)
      : options.cwdInput;

  if (typeof cwd !== "string") {
    throw new TypeError(`step ${options.stepId} cwd must resolve to a string.`);
  }

  await validateDirectoryCwd(cwd, `step ${options.stepId} cwd`);
  return cwd;
}

async function resolveStepCwdCallback(
  cwdInput: Exclude<StepCwdInput, string>,
  options: {
    readonly stepId: string;
    readonly workflowId: string;
    readonly input: PlainObject;
  },
): Promise<unknown> {
  const context = runContextStorage.getStore();
  if (!context) {
    throw new Error(`step ${options.stepId} cwd callback requires an active run context.`);
  }

  return await cwdInput({
    input: options.input,
    state: context.state,
    workflow: { id: options.workflowId },
  });
}
