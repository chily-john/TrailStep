import type { Workflow } from "../authoring/workflow.types.js";
import type { Failure } from "../shared/failure.js";
import type { PlainObject } from "../shared/shape.types.js";
import type { ProviderWorkingRunner } from "./provider-adapter/provider-adapter.types.js";
import type { StepKitConfig } from "./targeting/targeting.types.js";

export interface InteractiveProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: "inherit";
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
    | "workflow.failed"
    | "step.started"
    | "step.completed"
    | "step.failed"
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

export interface RunWorkflowOptions<
  TInput extends PlainObject = PlainObject,
  TOutput extends PlainObject = PlainObject,
> {
  readonly workflow: Workflow<TInput, TOutput>;
  readonly input: TInput;
  readonly runName: string;
  readonly cwd?: string;
  readonly eventSink?: (event: Event) => void | Promise<void>;
  readonly processRunner?: InteractiveProcessRunner;
  readonly stepkitConfig?: StepKitConfig;
  readonly workingAgentProcessRunner?: WorkingAgentProcessRunner;
  /** Injectable stdout-capturing runner for built-in registry provider adapters (e.g. Claude). Test-only seam. */
  readonly providerWorkingRunner?: ProviderWorkingRunner;
  readonly maxSteps?: number;
}
