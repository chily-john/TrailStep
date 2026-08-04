import type { StepKitConfig } from "../../agent-targeting/targeting.types.js";
import type { WorkflowAgentRole } from "../agents/agent-role.types.js";
import type { PlainObject } from "../shapes/shape.types.js";

export interface RunContextWorkingAgentProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: "inherit";
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
}

export interface RunContextWorkingAgentProcessResult {
  readonly exitCode: number;
}

export type RunContextWorkingAgentProcessRunner = (
  request: RunContextWorkingAgentProcessRequest,
) => RunContextWorkingAgentProcessResult | Promise<RunContextWorkingAgentProcessResult>;

export interface RunContextProviderWorkingProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface RunContextProviderWorkingProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type RunContextProviderWorkingRunner = (
  request: RunContextProviderWorkingProcessRequest,
) => RunContextProviderWorkingProcessResult | Promise<RunContextProviderWorkingProcessResult>;

export interface RunContextState {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface RunContextEvent<TPayload extends PlainObject = PlainObject> {
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

export interface RunContext {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly workflowId?: string;
  readonly workflowAgents?: Readonly<Record<string, WorkflowAgentRole>>;
  readonly cwd?: string;
  readonly stepkitConfig?: StepKitConfig;
  readonly workingAgentProcessRunner?: RunContextWorkingAgentProcessRunner;
  readonly providerWorkingRunner?: RunContextProviderWorkingRunner;
  readonly emit?: (event: RunContextEvent) => Promise<void>;
  readonly events?: () => readonly RunContextEvent[];
  readonly state: RunContextState;
  readonly currentStep?: {
    readonly id: string;
    readonly dir: string;
    readonly maxSubPrompts?: unknown;
    nextDocumentIndex(): number;
    nextSubPromptIndex(): number;
  };
}
