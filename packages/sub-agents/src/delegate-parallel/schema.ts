import { jsonSchema } from "@trailstep/authoring";
import type {
  DelegateInput,
  DelegateMode,
  DelegateOutput,
  DelegateWorktreeInput,
} from "../delegate/schema.js";
import { delegateWorktreeInputShape } from "../delegate/schema.js";

export type DelegateParallelDelegate =
  | "delegate"
  | "simple-explore"
  | "architect-planner"
  | "quick-implementor"
  | "smart-implementor"
  | "relentless-debugger"
  | "fixer"
  | "schema-formatter";

export interface DelegateParallelTaskInput extends Record<string, unknown> {
  readonly id: string;
  readonly mode?: DelegateMode;
  readonly delegate?: DelegateParallelDelegate;
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
  readonly delegate?: DelegateParallelDelegate;
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
    worktree: delegateWorktreeInputShape,
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          mode: { type: "string", enum: ["explore", "implement", "review", "general"] },
          delegate: {
            type: "string",
            enum: [
              "delegate",
              "simple-explore",
              "architect-planner",
              "quick-implementor",
              "smart-implementor",
              "relentless-debugger",
              "fixer",
              "schema-formatter",
            ],
          },
          task: { type: "string" },
          context: { type: "string" },
          cwd: { type: "string" },
          maxTurns: { type: "number" },
          summarize: { type: "boolean" },
          worktree: delegateWorktreeInputShape,
        },
        anyOf: [{ required: ["mode"] }, { required: ["delegate"] }],
        required: ["id", "task"],
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
