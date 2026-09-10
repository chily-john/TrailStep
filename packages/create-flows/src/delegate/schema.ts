import { jsonSchema } from "@trailstep/authoring";

export type DelegateMode = "explore" | "implement" | "review" | "general";
export type DelegateStatus = "completed" | "blocked" | "cancelled";
export type DelegateTurnStatus = "completed" | "continue" | "question" | "blocked";

export interface DelegateArtifact extends Record<string, unknown> {
  readonly name: string;
  readonly path: string;
  readonly mediaType?: string;
}

export interface DelegateWorktreeInput extends Record<string, unknown> {
  readonly enabled?: boolean;
  readonly baseBranch?: string;
  readonly cleanup?: "always" | "on-success" | "never";
}

export interface DelegateInput extends Record<string, unknown> {
  readonly task: string;
  readonly context?: string;
  readonly mode?: DelegateMode;
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly summarize?: boolean;
  readonly worktree?: DelegateWorktreeInput;
}

export interface DelegateOutput extends Record<string, unknown> {
  readonly status: DelegateStatus;
  readonly summary: string;
  readonly result?: string;
  readonly changedFiles?: readonly string[];
  readonly artifacts?: readonly DelegateArtifact[];
  readonly worktreePath?: string;
  readonly questionsAsked: number;
  readonly turns: number;
}

export interface DelegateTurnOutput extends Record<string, unknown> {
  readonly status: DelegateTurnStatus;
  readonly summary: string;
  readonly memoryPatch?: string;
  readonly question?: string;
  readonly result?: string;
  readonly changedFiles?: readonly string[];
  readonly artifacts?: readonly DelegateArtifact[];
}

export interface ParentAnswerOutput extends Record<string, unknown> {
  readonly answer: string;
}

export interface DelegateWorktreeOptions extends Record<string, unknown> {
  readonly enabled: boolean;
  readonly baseBranch?: string;
  readonly cleanup: "always" | "on-success" | "never";
}

export interface NormalizedDelegateInput extends Record<string, unknown> {
  readonly task: string;
  readonly context?: string;
  readonly mode: DelegateMode;
  readonly cwd?: string;
  readonly maxTurns: number;
  readonly summarize: boolean;
  readonly worktree: DelegateWorktreeOptions;
}

export interface QuestionAnswer extends Record<string, unknown> {
  readonly question: string;
  readonly answer: string;
}

export interface DelegateTurnInput extends Record<string, unknown> {
  readonly task: string;
  readonly context?: string;
  readonly mode: DelegateMode;
  readonly executionCwd: string;
  readonly worktreePath?: string;
  readonly memory: string;
  readonly questionsAndAnswers: readonly QuestionAnswer[];
  readonly latestSummary?: string;
  readonly turn: number;
  readonly maxTurns: number;
  readonly summarize: boolean;
}

export interface PrepareDelegateTurnInput extends Record<string, unknown> {
  readonly turn: number;
}

export interface AskParentInput extends Record<string, unknown> {
  readonly question: string;
  readonly nextTurn: number;
}

export const delegateArtifactShape = {
  type: "object",
  properties: {
    name: { type: "string" },
    path: { type: "string" },
    mediaType: { type: "string" },
  },
  required: ["name", "path"],
  additionalProperties: false,
} as const;

export const delegateInputShape = jsonSchema<DelegateInput>({
  type: "object",
  properties: {
    task: { type: "string" },
    context: { type: "string" },
    mode: { type: "string", enum: ["explore", "implement", "review", "general"] },
    cwd: { type: "string" },
    maxTurns: { type: "number" },
    summarize: { type: "boolean" },
    worktree: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        baseBranch: { type: "string" },
        cleanup: { type: "string", enum: ["always", "on-success", "never"] },
      },
      additionalProperties: false,
    },
  },
  required: ["task"],
  additionalProperties: false,
});

export const delegateOutputShape = jsonSchema<DelegateOutput>({
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "cancelled"] },
    summary: { type: "string" },
    result: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    artifacts: { type: "array", items: delegateArtifactShape },
    worktreePath: { type: "string" },
    questionsAsked: { type: "number" },
    turns: { type: "number" },
  },
  required: ["status", "summary", "questionsAsked", "turns"],
  additionalProperties: false,
});

export const delegateTurnOutputShape = jsonSchema<DelegateTurnOutput>({
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "continue", "question", "blocked"] },
    summary: { type: "string" },
    memoryPatch: { type: "string" },
    question: { type: "string" },
    result: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    artifacts: { type: "array", items: delegateArtifactShape },
  },
  required: ["status", "summary"],
  additionalProperties: false,
});

export const parentAnswerShape = jsonSchema<ParentAnswerOutput>({
  type: "object",
  properties: {
    answer: { type: "string" },
  },
  required: ["answer"],
  additionalProperties: false,
});

export function normalizeDelegateInput(input: DelegateInput): NormalizedDelegateInput {
  const mode = input.mode ?? "general";
  return {
    task: input.task,
    ...(nonEmptyOptional(input.context) === undefined
      ? {}
      : { context: nonEmptyOptional(input.context) }),
    mode,
    ...(nonEmptyOptional(input.cwd) === undefined ? {} : { cwd: nonEmptyOptional(input.cwd) }),
    maxTurns: normalizeMaxTurns(input.maxTurns),
    summarize: input.summarize ?? (mode === "explore" || mode === "general"),
    worktree: {
      enabled: input.worktree?.enabled ?? false,
      ...(nonEmptyOptional(input.worktree?.baseBranch) === undefined
        ? {}
        : { baseBranch: nonEmptyOptional(input.worktree?.baseBranch) }),
      cleanup: input.worktree?.cleanup ?? "on-success",
    },
  };
}

function normalizeMaxTurns(value: number | undefined): number {
  if (value === undefined) {
    return 10;
  }

  if (!Number.isFinite(value)) {
    return 10;
  }

  return Math.max(1, Math.floor(value));
}

function nonEmptyOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
