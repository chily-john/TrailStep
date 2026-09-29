import { defineWorkflow, done, parallel, state, step } from "@trailstep/authoring";
import type { DelegateMode, DelegateWorktreeInput } from "../delegate/schema.js";
import {
  delegate,
  delegateExplore,
  delegateImplement,
  delegateReview,
} from "../delegate/workflow.js";
import {
  type DelegateParallelInput,
  type DelegateParallelOutput,
  delegateParallelInputShape,
  delegateParallelOutputShape,
  type NormalizedDelegateParallelTask,
} from "./schema.js";

export type {
  DelegateParallelBranchOutput,
  DelegateParallelInput,
  DelegateParallelOutput,
  DelegateParallelTaskInput,
  NormalizedDelegateParallelTask,
} from "./schema.js";

export const delegateParallel = defineWorkflow<DelegateParallelInput, DelegateParallelOutput>({
  id: "delegateParallel",
  description: "Fans out required delegate tasks across parallel delegate workflows.",
  skill: delegateParallelSkill(),
  inputShape: delegateParallelInputShape,
  outputShape: delegateParallelOutputShape,
  start(input) {
    return initializeDelegateParallelStep(input);
  },
});

const initializeDelegateParallelStep = step({
  id: "initialize-delegate-parallel",
  title: "Initialize parallel delegates",
})
  .display(({ input }) => `Preparing ${(input as DelegateParallelInput).tasks.length} delegates`)
  .do((input: DelegateParallelInput) => {
    const normalized = normalizeDelegateParallelTasks(input, state.name);
    if (normalized.status === "blocked") {
      return done({ status: "blocked", summary: normalized.summary });
    }

    return parallel<DelegateParallelOutput>(
      normalized.tasks.map((task) =>
        delegateWorkflowForMode(task.mode)(task.input, { branch: task.branchId }),
      ),
    );
  });

export function normalizeDelegateParallelTasks(
  input: DelegateParallelInput,
  runName: string,
):
  | { readonly status: "ready"; readonly tasks: readonly NormalizedDelegateParallelTask[] }
  | { readonly status: "blocked"; readonly summary: string } {
  if (input.tasks.length === 0) {
    return { status: "blocked", summary: "delegateParallel requires at least one task." };
  }

  const seenIds = new Set<string>();
  const seenBranches = new Set<string>();
  const tasks: NormalizedDelegateParallelTask[] = [];

  for (const task of input.tasks) {
    const id = task.id.trim();
    const taskText = task.task.trim();
    if (id.length === 0) {
      return { status: "blocked", summary: "delegateParallel task ids must be non-empty." };
    }
    if (taskText.length === 0) {
      return {
        status: "blocked",
        summary: `delegateParallel task ${id} must include non-empty task text.`,
      };
    }
    if (seenIds.has(id)) {
      return { status: "blocked", summary: `delegateParallel task id '${id}' is duplicated.` };
    }
    seenIds.add(id);

    const branchId = `delegate-${stableSegment(id)}`;
    if (seenBranches.has(branchId)) {
      return {
        status: "blocked",
        summary: `delegateParallel task id '${id}' normalizes to duplicate branch id '${branchId}'.`,
      };
    }
    seenBranches.add(branchId);

    const cwd = nonEmpty(task.cwd) ?? nonEmpty(input.cwd);
    const worktree = normalizeTaskWorktree({
      parent: input.worktree,
      task: task.worktree,
      cwd,
      runName,
      taskSegment: stableSegment(id),
    });
    const context = combineContext(input.context, task.context);
    const maxTurns = task.maxTurns ?? input.maxTurns;
    const summarize = task.summarize ?? input.summarize;

    tasks.push({
      id,
      mode: task.mode,
      branchId,
      input: {
        task: taskText,
        mode: task.mode,
        ...(context === undefined ? {} : { context }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(maxTurns === undefined ? {} : { maxTurns }),
        ...(summarize === undefined ? {} : { summarize }),
        ...(worktree === undefined ? {} : { worktree }),
      },
    });
  }

  return { status: "ready", tasks };
}

function delegateWorkflowForMode(mode: DelegateMode): typeof delegate {
  switch (mode) {
    case "explore":
      return delegateExplore;
    case "implement":
      return delegateImplement;
    case "review":
      return delegateReview;
    case "general":
      return delegate;
  }
}

function normalizeTaskWorktree(input: {
  readonly parent?: DelegateWorktreeInput;
  readonly task?: DelegateWorktreeInput;
  readonly cwd?: string;
  readonly runName: string;
  readonly taskSegment: string;
}): DelegateWorktreeInput | undefined {
  if (input.cwd !== undefined) {
    return input.task?.enabled === true ? input.task : undefined;
  }

  const enabled = input.task?.enabled ?? input.parent?.enabled;
  if (enabled !== true) {
    return input.task ?? input.parent;
  }

  const merged = { ...input.parent, ...input.task, enabled: true };
  return {
    ...merged,
    path: nonEmpty(merged.path) ?? `.trailstep/worktrees/${input.runName}/${input.taskSegment}`,
    branch: nonEmpty(merged.branch) ?? `trailstep/delegate/${input.runName}/${input.taskSegment}`,
  };
}

function combineContext(parent: string | undefined, task: string | undefined): string | undefined {
  const parentContext = nonEmpty(parent);
  const taskContext = nonEmpty(task);
  if (parentContext === undefined) {
    return taskContext;
  }
  if (taskContext === undefined) {
    return parentContext;
  }
  return `${parentContext}\n\n${taskContext}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function stableSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment.length > 0 ? segment : `task-${hashString(value)}`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function delegateParallelSkill(): string {
  return `---
name: trst-delegate-parallel
description: Use as a parent-agent fan-out tool for required TrailStep delegate tasks that can run in parallel.
x-trailstep-user-facing: false
---
# TrailStep delegateParallel workflow

Use this workflow when a parent agent already has a set of concrete, independent delegate tasks. It fans out directly to the existing delegate, delegateExplore, delegateReview, and delegateImplement workflows based on each task mode. It does not add a planning agent and does not merge results beyond returning the parallel branch outputs.

Each task must provide a stable \`id\`, \`mode\`, and \`task\` text. Shared \`context\`, \`cwd\`, \`maxTurns\`, \`summarize\`, and \`worktree\` values are applied as defaults; task-level values override them. Managed worktrees under \`worktree.enabled=true\` default per task to \`.trailstep/worktrees/<runName>/<taskId>\` and \`trailstep/delegate/<runName>/<taskId>\` to avoid collisions.`;
}
