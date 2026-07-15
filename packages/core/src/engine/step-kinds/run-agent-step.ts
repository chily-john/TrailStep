import type {
  AgentStep,
  AgentStepRequestConfig,
} from "../../authoring/step-kinds/agent-step.types.js";
import type { AgentModelTarget } from "../../shared/agent-role.types.js";
import type {
  AgentAdapter,
  AgentAdapterSelection,
  AgentPrompt,
  AgentTool,
} from "../../shared/agent-selection.types.js";
import { StepKitFailureError } from "../../shared/failure.js";
import type { PlainObject, Schema } from "../../shared/shape.types.js";

const PROVIDER_NEUTRAL_ADAPTER_KEY = "custom";
const PROVIDER_NEUTRAL_MODEL = "configured-agent";

export interface AgentToolCallEvent {
  readonly name: string;
  readonly input: PlainObject;
  readonly output: PlainObject;
}

export interface RunAgentStepOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly step: AgentStepRequestConfig<TInput, TOutput>;
  readonly input: TInput;
  readonly workflowAdapter?: AgentAdapterSelection<TInput, TOutput>;
  readonly onToolCall?: (event: AgentToolCallEvent) => void | Promise<void>;
}

export async function runAgentStep<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(options: RunAgentStepOptions<TInput, TOutput>): Promise<PlainObject> {
  const model = resolveAgentRequirements(options.step.requirements);
  const adapter = resolveAgentAdapter(options.step.adapter ?? options.workflowAdapter);
  let submittedOutput: PlainObject | undefined;

  const tools: AgentTool<TOutput>[] = [
    createSubmitOutputTool(options.step.output, async (output) => {
      options.step.output.assert(output, `agent step ${options.step.id} submit_output`);
      submittedOutput = output;
      await options.onToolCall?.({
        name: "submit_output",
        input: output,
        output: { accepted: true },
      });
    }),
  ];

  const prompt = renderAgentPrompt(options.step.prompt, options.input);

  await adapter({
    messages: [{ role: "user", content: prompt }],
    tools,
    requirements: options.step.requirements,
    model,
    step: options.step,
    input: options.input,
  });

  if (submittedOutput === undefined) {
    throw new StepKitFailureError({
      code: "agent_output_missing",
      message: `Agent step ${options.step.id} did not call submit_output.`,
    });
  }

  return submittedOutput;
}

export function renderAgentPrompt<TInput extends PlainObject>(
  prompt: AgentPrompt<TInput>,
  input: TInput,
): string {
  return typeof prompt === "function" ? prompt({ input }) : prompt;
}

export function resolveAgentRequirements(
  requirements: AgentStep["requirements"],
): AgentModelTarget {
  return {
    adapterKey: PROVIDER_NEUTRAL_ADAPTER_KEY,
    model: requirements.name ?? requirements.size ?? PROVIDER_NEUTRAL_MODEL,
  };
}

function resolveAgentAdapter<TInput extends PlainObject, TOutput extends PlainObject = PlainObject>(
  selection: AgentAdapterSelection<TInput, TOutput> | undefined,
): AgentAdapter<TInput, TOutput> {
  if (typeof selection === "function") {
    return selection;
  }

  if (typeof selection === "object" && selection !== null) {
    return (request) => selection.runAgentStep(request);
  }

  throw new StepKitFailureError({
    code: "agent_adapter_unavailable",
    message:
      "Agent steps that do not use a configured command runner require a custom adapter function or adapter object.",
  });
}

function createSubmitOutputTool<TOutput extends PlainObject>(
  schema: Schema<TOutput>,
  onOutput: (output: TOutput) => void | Promise<void>,
): AgentTool<TOutput> {
  return {
    name: "submit_output",
    description: "Submit the typed output for this StepKit agent step.",
    schema,
    async call(input) {
      await onOutput(input);
    },
  };
}
