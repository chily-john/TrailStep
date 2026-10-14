import type { AgentStepRequestConfig } from "../../../authoring/step/agent-step.types.js";
import type {
  AgentAdapter,
  AgentAdapterSelection,
  AgentPrompt,
  AgentTool,
} from "../../../contracts/agents/agent-adapter.types.js";
import type { AgentModelTarget } from "../../../contracts/agents/agent-role.types.js";
import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import { readWorkingAgentOutput } from "../../working-agent/output/read-working-agent-output.js";
import { resolveStepAgentFiles } from "../../working-agent/artifacts/resolve-step-agent-files.js";
import type { PlainObject, Schema } from "../../../contracts/shapes/shape.types.js";

const PROVIDER_NEUTRAL_ADAPTER_KEY = "custom";
const PROVIDER_NEUTRAL_MODEL = "configured-agent";
const DEFAULT_ADAPTER_TIMEOUT_MS = 120_000;

function buildOutputPrompt(outputSchema: Schema<PlainObject>): string {
  const jsonSchema = outputSchema.jsonSchema;
  const properties = (jsonSchema.properties as Record<string, unknown>) ?? {};
  const required = (jsonSchema.required as string[]) ?? [];
  const fields = Object.entries(properties)
    .map(([key, def]) => {
      const type = (def as Record<string, unknown>).type ?? "unknown";
      const desc = (def as Record<string, unknown>).description ?? "";
      const req = required.includes(key) ? " (required)" : "";
      return `  - ${key}: ${type}${req}${desc ? ` — ${desc}` : ""}`;
    })
    .join("\n");

  return `\n\nNow produce the final structured output as a JSON object matching this schema:\n${fields}\n\nCall the submit_output tool with the result.`;
}

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
  readonly onToolCall?: (event: AgentToolCallEvent) => void | Promise<void>;
  readonly runDir?: string;
  readonly stepIndex?: number;
}

export async function runAgentStep<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
>(options: RunAgentStepOptions<TInput, TOutput>): Promise<PlainObject> {
  const model = resolveAgentRequirements(options.step.requirements);
  const adapter = resolveAgentAdapter(options.step.adapter);
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
  const outputPrompt = buildOutputPrompt(options.step.output as Schema<PlainObject>);
  const adapterTimeoutMs = options.step.timeout ?? DEFAULT_ADAPTER_TIMEOUT_MS;

  // Round 1: Work prompt
  await runAdapterWithTimeout(
    adapter,
    {
      messages: [{ role: "user", content: prompt }],
      tools,
      requirements: options.step.requirements,
      model,
      step: options.step,
      input: options.input,
    },
    adapterTimeoutMs,
  );

  // Round 2: Output prompt (reprompt same session for structured output)
  await runAdapterWithTimeout(
    adapter,
    {
      messages: [
        { role: "user", content: prompt },
        { role: "user", content: outputPrompt },
      ],
      tools,
      requirements: options.step.requirements,
      model,
      step: options.step,
      input: options.input,
    },
    adapterTimeoutMs,
  );

  if (submittedOutput === undefined) {
    // Multi-round prompting fallback: adapter session may have finished
    // and written output.json without calling submit_output. Read it defensively.
    try {
      if (options.runDir !== undefined && options.stepIndex !== undefined) {
        const files = resolveStepAgentFiles({
          runDir: options.runDir,
          stepId: options.step.id,
          stepIndex: options.stepIndex,
        });
        submittedOutput = (await readWorkingAgentOutput({
          stepId: options.step.id,
          outputFile: files.outputFile,
          step: options.step,
        })) as PlainObject;
      }
    } catch {
      // File missing, corrupt, or invalid — fall through to agent_output_missing.
    }
  }

  if (submittedOutput === undefined) {
    throw new TrailStepFailureError({
      code: "agent_output_missing",
      message: `Agent step ${options.step.id} did not call submit_output and no valid output.json was found.`,
    });
  }

  return submittedOutput;
}

async function runAdapterWithTimeout<
  TInput extends PlainObject,
  TOutput extends PlainObject = PlainObject,
>(
  adapter: AgentAdapter<TInput, TOutput>,
  request: Parameters<AgentAdapter<TInput, TOutput>>[0],
  timeoutMs: number,
): Promise<void> {
  return Promise.race([
    adapter(request),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("adapter_timeout")), timeoutMs),
    ),
  ]);
}

export function renderAgentPrompt<TInput extends PlainObject>(
  prompt: AgentPrompt<TInput>,
  input: TInput,
): string {
  return typeof prompt === "function" ? prompt({ input }) : prompt;
}

export function resolveAgentRequirements(
  requirements: AgentStepRequestConfig["requirements"],
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

  throw new TrailStepFailureError({
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
    description: "Submit the typed output for this TrailStep agent step.",
    schema,
    async call(input) {
      await onOutput(input);
    },
  };
}
