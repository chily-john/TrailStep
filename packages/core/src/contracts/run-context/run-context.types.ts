import type { TrailStepConfig } from "../../agent-targeting/targeting.types.js";
import type { WorkflowAgentRole } from "../agents/agent-role.types.js";
import type { PlainObject } from "../shapes/shape.types.js";

export interface RunContextWorkingAgentProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly stdio: "inherit" | "pipe";
  readonly promptFile: string;
  readonly outputFile: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface RunContextWorkingAgentProcessResult {
  readonly exitCode: number;
  readonly stdout?: string;
}

export type RunContextWorkingAgentProcessRunner = (
  request: RunContextWorkingAgentProcessRequest,
) => RunContextWorkingAgentProcessResult | Promise<RunContextWorkingAgentProcessResult>;

export interface RunContextProviderWorkingProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
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

export interface RunContextGlobalState extends RunContextState {
  update<T = unknown>(key: string, updater: (current: T | undefined) => T | Promise<T>): Promise<T>;
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
    | "workflow.cancelRequested"
    | "workflow.failed"
    | "workflow.cancelled"
    | "step.started"
    | "step.completed"
    | "step.failed"
    | "step.cancelled"
    | "step.display"
    | "step.progress"
    | "step.warning"
    | "step.artifact"
    | "wait.started"
    | "wait.satisfied"
    | "wait.failed"
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
  /** Root used for workflow/config-relative resolution and default artifact storage. */
  readonly projectCwd?: string;
  /** Current execution cwd. In step context this includes any step-level cwd override. */
  readonly cwd?: string;
  /** Alias for `cwd`, exposed to make execution-vs-project cwd intent explicit. */
  readonly executionCwd?: string;
  readonly trailstepConfig?: TrailStepConfig;
  readonly workingAgentProcessRunner?: RunContextWorkingAgentProcessRunner;
  readonly providerWorkingRunner?: RunContextProviderWorkingRunner;
  readonly emit?: (event: RunContextEvent) => Promise<void>;
  readonly events?: () => readonly RunContextEvent[];
  readonly state: RunContextState;
  readonly globalState: RunContextGlobalState;
  readonly currentStep?: {
    readonly id: string;
    readonly dir: string;
    readonly maxSubPrompts?: unknown;
    readonly cwd?: string;
    readonly executionCwd?: string;
    readonly replay?: { readonly kind: "completed-step" };
    nextDocumentIndex(): number;
    nextSubPromptIndex(): number;
  };
}
