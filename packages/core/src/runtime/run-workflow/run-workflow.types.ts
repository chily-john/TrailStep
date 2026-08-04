import type { StepKitConfig } from "../../agent-targeting/targeting.types.js";
import type { Workflow } from "../../authoring/workflow/workflow.types.js";
import type { Failure } from "../../contracts/failures/failure.js";
import type { PlainObject } from "../../contracts/shapes/shape.types.js";
import type { ProviderWorkingRunner } from "../../known-cli-providers/registry/provider-registry.types.js";

export type StepKitConfigInput = StepKitConfig | Readonly<Record<string, unknown>>;

export interface InteractiveProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: "inherit";
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface InteractiveProcessResult {
  readonly exitCode: number;
}

export type InteractiveProcessRunner = (
  request: InteractiveProcessRequest,
) => InteractiveProcessResult | Promise<InteractiveProcessResult>;

export interface WorkingAgentProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: "inherit";
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface WorkingAgentProcessResult {
  readonly exitCode: number;
}

export type WorkingAgentProcessRunner = (
  request: WorkingAgentProcessRequest,
) => WorkingAgentProcessResult | Promise<WorkingAgentProcessResult>;

export interface Event<TPayload extends PlainObject = PlainObject> {
  readonly id: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId?: string;
  readonly type:
    | "workflow.started"
    | "workflow.resumed"
    | "workflow.retryStarted"
    | "workflow.failed"
    | "step.started"
    | "step.completed"
    | "step.failed"
    | "subPrompt.started"
    | "subPrompt.completed"
    | "subPrompt.failed"
    | "interactive.sessionStarted"
    | "interactive.sessionCompleted"
    | "agent.toolCall"
    | "workflow.completed";
  readonly timestamp: string;
  readonly schemaVersion: "v0";
  readonly payload: TPayload;
}

export type Result<TOutput extends PlainObject = PlainObject> =
  | {
      readonly status: "success";
      readonly runId: string;
      readonly runDir: string;
      readonly output: TOutput;
      readonly events: readonly Event[];
    }
  | {
      readonly status: "failure";
      readonly runId: string;
      readonly runDir: string;
      readonly failure: Failure;
      readonly events: readonly Event[];
    };

interface RunWorkflowBaseOptions<TInput extends PlainObject, TOutput extends PlainObject> {
  readonly workflow: Workflow<TInput, TOutput>;
  readonly cwd?: string;
  readonly eventSink?: (event: Event) => void | Promise<void>;
  readonly processRunner?: InteractiveProcessRunner;
  readonly stepkitConfig?: StepKitConfigInput;
  readonly workingAgentProcessRunner?: WorkingAgentProcessRunner;
  /** Injectable stdout-capturing runner for built-in registry provider adapters (e.g. Claude). Test-only seam. */
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly maxSteps?: number;
}

export type RunWorkflowOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> = RunWorkflowBaseOptions<TInput, TOutput> &
  (
    | {
        readonly input: TInput;
        readonly runName: string;
        readonly resume?: undefined;
        readonly retry?: undefined;
      }
    | {
        readonly resume: { readonly runDir: string };
        readonly input?: undefined;
        readonly runName?: undefined;
        readonly retry?: undefined;
      }
    | {
        readonly retry: { readonly runDir: string; readonly kind: "manual" | "automatic" };
        readonly input?: undefined;
        readonly runName?: undefined;
        readonly resume?: undefined;
      }
  );
