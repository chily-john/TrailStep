import { jsonSchema } from "@trailstep/authoring";
import type {
  DelegateInput,
  DelegateMode,
  DelegateOutput,
  DelegateWorktreeInput,
} from "../delegate/schema.js";

export interface DelegateParallelTaskInput extends Record<string, unknown> {
  readonly id: string;
  readonly mode: DelegateMode;
  readonly task: string;
  readonly context?: string;
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly summarize?: boolean;
  readonly worktree?: DelegateWorktreeInput;
}

export interface DelegateParallelInput extends Record<string, unknown> {
  readonly context?: string;
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly summarize?: boolean;
  readonly worktree?: DelegateWorktreeInput;
  readonly tasks: readonly DelegateParallelTaskInput[];
}

export interface DelegateParallelBranchOutput extends Record<string, unknown> {
  readonly status: "done" | "failed" | "cancelled";
  readonly output?: DelegateOutput;
}

export interface DelegateParallelOutput extends Record<string, unknown> {
  readonly status: "completed" | "blocked";
  readonly summary?: string;
  readonly branches?: Record<string, DelegateParallelBranchOutput>;
}

export interface NormalizedDelegateParallelTask extends Record<string, unknown> {
  readonly id: string;
  readonly mode: DelegateMode;
  readonly branchId: string;
  readonly input: DelegateInput;
}

export const delegateParallelInputShape = jsonSchema<DelegateParallelInput>({
  type: "object",
  properties: {
    context: { type: "string" },
    cwd: { type: "string" },
    maxTurns: { type: "number" },
    summarize: { type: "boolean" },
    worktree: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        path: { type: "string" },
        baseRef: { type: "string" },
        baseBranch: { type: "string" },
        branch: { type: "string" },
        cleanup: { type: "string", enum: ["auto", "never", "always"] },
        forceCleanup: { type: "boolean" },
      },
      additionalProperties: false,
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          mode: { type: "string", enum: ["explore", "implement", "review", "general"] },
          task: { type: "string" },
          context: { type: "string" },
          cwd: { type: "string" },
          maxTurns: { type: "number" },
          summarize: { type: "boolean" },
          worktree: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              path: { type: "string" },
              baseRef: { type: "string" },
              baseBranch: { type: "string" },
              branch: { type: "string" },
              cleanup: { type: "string", enum: ["auto", "never", "always"] },
              forceCleanup: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        required: ["id", "mode", "task"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
});

export const delegateParallelOutputShape = jsonSchema<DelegateParallelOutput>({
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    branches: { type: "object", additionalProperties: true },
  },
  required: ["status"],
  additionalProperties: false,
});
