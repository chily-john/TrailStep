import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { done, notify, type StepFactory, state, step } from "@trailstep/authoring";
import { delegateTurnPrompt } from "./prompts.js";
import {
  type AskParentInput,
  type DelegateArtifact,
  type DelegateInput,
  type DelegateOutput,
  type DelegateTurnInput,
  type DelegateTurnOutput,
  type DelegateWorkflowDefaults,
  type DelegateWorktreeCleanupDetails,
  delegateTurnOutputShape,
  type NormalizedDelegateInput,
  normalizeDelegateInput,
  type ParentAnswerOutput,
  type PrepareDelegateTurnInput,
  parentAnswerShape,
  type QuestionAnswer,
} from "./schema.js";

const MEMORY_LIMIT = 12_000;
const execFileAsync = promisify(execFile);

const DELEGATE_STATE_KEYS = {
  initialized: "delegate.initialized",
  input: "delegate.input",
  memory: "delegate.memory",
  turns: "delegate.turns",
  questions: "delegate.questions",
  answers: "delegate.answers",
  latestSummary: "delegate.latestSummary",
  artifacts: "delegate.artifacts",
  changedFiles: "delegate.changedFiles",
  result: "delegate.result",
  worktreePath: "delegate.worktreePath",
  worktreeBranch: "delegate.worktreeBranch",
  worktreeCleanup: "delegate.worktreeCleanup",
} as const;

interface InitializeDelegateInput extends Record<string, unknown> {
  readonly input: DelegateInput;
  readonly defaults: DelegateWorkflowDefaults;
}

export function initializeDelegateStep(
  input: DelegateInput,
  defaults: DelegateWorkflowDefaults = {},
): ReturnType<typeof initializeDelegateStepFactory> {
  return initializeDelegateStepFactory({ input, defaults });
}

const initializeDelegateStepFactory = step({
  id: "initialize-delegate",
  title: "Initialize delegate",
})
  .display(({ input }) => `Delegating: ${(input as InitializeDelegateInput).input.task}`)
  .do(async ({ input, defaults }: InitializeDelegateInput) => {
    const initialized = (await state.get<boolean>(DELEGATE_STATE_KEYS.initialized)) ?? false;
    if (initialized) {
      return prepareDelegateTurnStep({ turn: 1 });
    }

    const normalized = normalizeDelegateInput(input, defaults);

    if (normalized.cwd !== undefined && normalized.worktree.enabled) {
      return await finalDone({
        status: "blocked",
        summary:
          "Delegate input cannot specify both cwd and worktree.enabled. Choose an existing cwd or managed worktree creation, not both.",
        questionsAsked: 0,
        turns: 0,
      });
    }

    const managedWorktree = normalized.worktree.enabled
      ? await createManagedWorktree(normalized)
      : undefined;
    const executionCwd = managedWorktree?.path ?? resolveDelegateCwd(normalized.cwd);
    const normalizedInput = {
      ...normalized,
      ...(normalized.cwd !== undefined || managedWorktree !== undefined
        ? { cwd: executionCwd }
        : {}),
    };

    await state.set(DELEGATE_STATE_KEYS.initialized, true);
    await state.set(DELEGATE_STATE_KEYS.input, normalizedInput);
    await state.set(DELEGATE_STATE_KEYS.memory, "");
    await state.set(DELEGATE_STATE_KEYS.turns, 0);
    await state.set(DELEGATE_STATE_KEYS.questions, 0);
    await state.set(DELEGATE_STATE_KEYS.answers, []);
    await state.set(DELEGATE_STATE_KEYS.latestSummary, null);
    await state.set(DELEGATE_STATE_KEYS.artifacts, []);
    await state.set(DELEGATE_STATE_KEYS.changedFiles, []);
    await state.set(DELEGATE_STATE_KEYS.result, null);
    await state.set(DELEGATE_STATE_KEYS.worktreePath, managedWorktree?.path ?? null);
    await state.set(DELEGATE_STATE_KEYS.worktreeBranch, managedWorktree?.branch ?? null);
    await state.set(DELEGATE_STATE_KEYS.worktreeCleanup, null);

    await notify.progress("Initialized delegate memory", {
      mode: normalizedInput.mode,
      maxTurns: normalizedInput.maxTurns,
      cwd: executionCwd,
      ...(managedWorktree === undefined
        ? {}
        : { worktreePath: managedWorktree.path, worktreeBranch: managedWorktree.branch }),
    });

    return prepareDelegateTurnStep({ turn: 1 });
  });

export const prepareDelegateTurnStep: StepFactory<
  PrepareDelegateTurnInput,
  PrepareDelegateTurnInput
> = step({
  id: "prepare-delegate-turn",
  title: "Prepare delegate turn",
}).do(async (turnRequest: PrepareDelegateTurnInput) => {
  const input = await requiredState<NormalizedDelegateInput>(DELEGATE_STATE_KEYS.input);
  const turns = (await state.get<number>(DELEGATE_STATE_KEYS.turns)) ?? 0;
  const questionsAsked = (await state.get<number>(DELEGATE_STATE_KEYS.questions)) ?? 0;

  if (turnRequest.turn > input.maxTurns) {
    await notify.warning("Delegate exceeded maxTurns", { maxTurns: input.maxTurns, turns });
    return await finalDone({
      status: "blocked",
      summary: "Delegate exceeded maxTurns without completing.",
      ...(await finalOptionalOutputFields()),
      questionsAsked,
      turns,
    });
  }

  const executionCwd = input.cwd ?? state.executionCwd ?? state.cwd ?? process.cwd();
  const turnInput: DelegateTurnInput = {
    task: input.task,
    ...(input.context === undefined ? {} : { context: input.context }),
    mode: input.mode,
    executionCwd,
    ...(input.worktree.enabled ? { worktreePath: executionCwd } : {}),
    memory: (await state.get<string>(DELEGATE_STATE_KEYS.memory)) ?? "",
    questionsAndAnswers: (await state.get<QuestionAnswer[]>(DELEGATE_STATE_KEYS.answers)) ?? [],
    latestSummary: (await state.get<string | null>(DELEGATE_STATE_KEYS.latestSummary)) ?? undefined,
    turn: turnRequest.turn,
    maxTurns: input.maxTurns,
    summarize: input.summarize,
  };

  return delegateTurnStep(turnInput);
});

export const delegateTurnStep: StepFactory<DelegateTurnInput, DelegateTurnOutput> = step({
  id: "delegate-turn",
  title: "Delegate turn",
  cwd: ({ input }) => (input as DelegateTurnInput).executionCwd,
})
  .display(({ input }) => `Delegating: ${(input as DelegateTurnInput).task}`)
  .prompt<DelegateTurnInput, DelegateTurnOutput>(delegateTurnPrompt, {
    agent: "delegateAgent",
    output: delegateTurnOutputShape,
  })
  .display(({ output }) => output.summary)
  .do(async (turnOutput, input) => {
    const storedTurns = (await state.get<number>(DELEGATE_STATE_KEYS.turns)) ?? 0;
    const alreadyProcessed = storedTurns >= input.turn;
    const turns = alreadyProcessed ? storedTurns : storedTurns + 1;

    if (!alreadyProcessed) {
      await state.set(DELEGATE_STATE_KEYS.turns, turns);
      await state.set(DELEGATE_STATE_KEYS.latestSummary, turnOutput.summary);
      await appendMemory(turns, turnOutput);
      await mergeChangedFiles(turnOutput.changedFiles ?? []);
      await mergeArtifacts(turnOutput.artifacts ?? []);
      await state.set(DELEGATE_STATE_KEYS.result, turnOutput.result ?? null);

      await notify.progress("Updated delegate memory", { turn: turns });
      for (const artifact of turnOutput.artifacts ?? []) {
        await notify.artifact(artifact.name, {
          path: artifact.path,
          ...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType }),
        });
      }
    }

    if (turnOutput.status === "completed") {
      const questionsAsked = (await state.get<number>(DELEGATE_STATE_KEYS.questions)) ?? 0;
      return await finalDone({
        status: "completed",
        summary: turnOutput.summary,
        ...(await finalOptionalOutputFields(turnOutput)),
        questionsAsked,
        turns,
      });
    }

    if (turnOutput.status === "blocked") {
      const questionsAsked = (await state.get<number>(DELEGATE_STATE_KEYS.questions)) ?? 0;
      return await finalDone({
        status: "blocked",
        summary: turnOutput.summary,
        ...(await finalOptionalOutputFields(turnOutput)),
        questionsAsked,
        turns,
      });
    }

    if (turnOutput.status === "question") {
      const question = turnOutput.question?.trim();
      if (!question) {
        const questionsAsked = (await state.get<number>(DELEGATE_STATE_KEYS.questions)) ?? 0;
        return await finalDone({
          status: "blocked",
          summary: "Delegate requested a parent answer but did not provide a question.",
          ...(await finalOptionalOutputFields(turnOutput)),
          questionsAsked,
          turns,
        });
      }

      const storedQuestions = (await state.get<number>(DELEGATE_STATE_KEYS.questions)) ?? 0;
      const questionsAsked = alreadyProcessed ? storedQuestions : storedQuestions + 1;
      if (!alreadyProcessed) {
        await state.set(DELEGATE_STATE_KEYS.questions, questionsAsked);
        await notify.progress("Delegate asked parent question", {
          turn: input.turn,
          questionsAsked,
        });
      }
      return askParentStep({ question, nextTurn: input.turn + 1 });
    }

    return prepareDelegateTurnStep({ turn: input.turn + 1 });
  });

export const askParentStep: StepFactory<AskParentInput, AskParentInput> = step({
  id: "ask-parent",
  title: "Ask parent",
})
  .display(({ input }) => (input as AskParentInput).question)
  .wait(({ input }) => ({
    id: "parent-answer",
    kind: "input",
    message: (input as AskParentInput).question,
    output: parentAnswerShape,
  }))
  .do(async (context, input: AskParentInput) => {
    const waitContext = context as unknown as AskParentInput & {
      readonly waits?: Readonly<Record<string, ParentAnswerOutput>>;
    };
    const answerOutput = waitContext.waits?.["parent-answer"];
    const answer = answerOutput?.answer ?? "";
    const answers = (await state.get<QuestionAnswer[]>(DELEGATE_STATE_KEYS.answers)) ?? [];
    const alreadyRecorded = answers.some(
      (item) => item.question === input.question && item.answer === answer,
    );

    if (answerOutput !== undefined && !alreadyRecorded) {
      await state.set(DELEGATE_STATE_KEYS.answers, [
        ...answers,
        { question: input.question, answer },
      ]);
      await appendMemoryNote(`Parent answered: ${answer}`);
      await notify.progress("Recorded parent answer", { questionsAnswered: answers.length + 1 });
    }

    return prepareDelegateTurnStep({ turn: input.nextTurn });
  });

async function createManagedWorktree(
  input: NormalizedDelegateInput,
): Promise<{ path: string; branch: string }> {
  const base = state.projectCwd ?? state.executionCwd ?? state.cwd ?? process.cwd();
  const safeRunName = sanitizeRefSegment(state.name);
  const worktreePath = resolve(base, input.worktree.path ?? `.trailstep/worktrees/${safeRunName}`);
  const branch = input.worktree.branch ?? `trailstep/delegate/${safeRunName}`;
  const baseRef = input.worktree.baseRef ?? input.worktree.baseBranch ?? "HEAD";

  await mkdir(dirname(worktreePath), { recursive: true });
  await git(base, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
  await notify.progress("Created delegate worktree", { path: worktreePath, branch, baseRef });
  return { path: worktreePath, branch };
}

async function cleanupManagedWorktree(
  finalStatus: DelegateOutput["status"],
): Promise<DelegateWorktreeCleanupDetails | undefined> {
  const input = await state.get<NormalizedDelegateInput>(DELEGATE_STATE_KEYS.input);
  const worktreePath = await state.get<string | null>(DELEGATE_STATE_KEYS.worktreePath);
  const worktreeBranch = await state.get<string | null>(DELEGATE_STATE_KEYS.worktreeBranch);
  if (input?.worktree.enabled !== true || worktreePath === undefined || worktreePath === null) {
    return undefined;
  }

  const requested = input.worktree.cleanup;
  const keep = async (status: DelegateWorktreeCleanupDetails["status"], reason: string) => {
    const details = { requested, status, reason } satisfies DelegateWorktreeCleanupDetails;
    await state.set(DELEGATE_STATE_KEYS.worktreeCleanup, details);
    await notify.progress("Kept delegate worktree", { path: worktreePath, reason });
    return details;
  };

  if (requested === "never") {
    return keep("kept", "cleanup=never");
  }
  if (requested === "auto" && finalStatus !== "completed") {
    return keep("kept", "auto cleanup keeps worktree because delegate did not complete");
  }

  let clean = false;
  try {
    clean = (await git(worktreePath, ["status", "--porcelain"])).trim().length === 0;
  } catch (error) {
    return keep("failed", `could not prove worktree cleanliness: ${errorMessage(error)}`);
  }

  if (!clean && !input.worktree.forceCleanup) {
    return keep("kept-dirty", "worktree has changes and forceCleanup is false");
  }

  const repoCwd = state.projectCwd ?? state.executionCwd ?? state.cwd ?? process.cwd();
  try {
    const args = [
      "worktree",
      "remove",
      ...(input.worktree.forceCleanup ? ["--force"] : []),
      worktreePath,
    ];
    await git(repoCwd, args);
  } catch (error) {
    return keep("failed", `git worktree remove failed: ${errorMessage(error)}`);
  }

  const branchCleanupReason = await cleanupManagedWorktreeBranch({
    repoCwd,
    branch: worktreeBranch,
    createdByRun: input.worktree.branch === undefined,
  });
  const details = {
    requested,
    status: branchCleanupReason?.startsWith("managed branch cleanup failed") ? "failed" : "removed",
    ...(branchCleanupReason === undefined ? {} : { reason: branchCleanupReason }),
  } satisfies DelegateWorktreeCleanupDetails;
  await state.set(DELEGATE_STATE_KEYS.worktreeCleanup, details);
  await notify.progress("Removed delegate worktree", {
    path: worktreePath,
    reason: branchCleanupReason,
  });
  return details;
}

async function cleanupManagedWorktreeBranch({
  repoCwd,
  branch,
  createdByRun,
}: {
  readonly repoCwd: string;
  readonly branch: string | null | undefined;
  readonly createdByRun: boolean;
}): Promise<string | undefined> {
  if (branch === undefined || branch === null) {
    return undefined;
  }
  if (!createdByRun) {
    return "user-supplied branch retained";
  }

  let currentBranch: string;
  try {
    currentBranch = (await git(repoCwd, ["branch", "--show-current"])).trim();
  } catch (error) {
    return `managed branch cleanup failed after worktree removal: could not determine current branch: ${errorMessage(error)}`;
  }
  if (currentBranch === branch) {
    return "managed branch retained because it is currently checked out";
  }

  try {
    await git(repoCwd, ["branch", "-d", branch]);
    return undefined;
  } catch (error) {
    return `managed branch cleanup failed after worktree removal: ${errorMessage(error)}`;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function resolveDelegateCwd(cwd: string | undefined): string {
  const base = state.projectCwd ?? state.executionCwd ?? state.cwd ?? process.cwd();
  return cwd === undefined ? base : resolve(base, cwd);
}

function sanitizeRefSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendMemory(turn: number, output: DelegateTurnOutput): Promise<void> {
  const lines = [`Turn ${turn}: ${output.summary}`];
  if (output.memoryPatch?.trim()) {
    lines.push(`Memory patch: ${output.memoryPatch.trim()}`);
  }
  await appendMemoryNote(lines.join("\n"));
}

async function appendMemoryNote(note: string): Promise<void> {
  const existing = (await state.get<string>(DELEGATE_STATE_KEYS.memory)) ?? "";
  const updated = [existing.trim(), note.trim()].filter(Boolean).join("\n\n");
  await state.set(DELEGATE_STATE_KEYS.memory, trimRollingMemory(updated));
}

function trimRollingMemory(memory: string): string {
  if (memory.length <= MEMORY_LIMIT) {
    return memory;
  }

  return `[older delegate memory trimmed]\n${memory.slice(-MEMORY_LIMIT)}`;
}

async function mergeChangedFiles(changedFiles: readonly string[]): Promise<void> {
  if (changedFiles.length === 0) {
    return;
  }

  const existing = (await state.get<string[]>(DELEGATE_STATE_KEYS.changedFiles)) ?? [];
  await state.set(DELEGATE_STATE_KEYS.changedFiles, uniqueStrings([...existing, ...changedFiles]));
}

async function mergeArtifacts(artifacts: readonly DelegateArtifact[]): Promise<void> {
  if (artifacts.length === 0) {
    return;
  }

  const existing = (await state.get<DelegateArtifact[]>(DELEGATE_STATE_KEYS.artifacts)) ?? [];
  const byPath = new Map(existing.map((artifact) => [artifact.path, artifact]));
  for (const artifact of artifacts) {
    byPath.set(artifact.path, artifact);
  }
  await state.set(DELEGATE_STATE_KEYS.artifacts, [...byPath.values()]);
}

async function finalOptionalOutputFields(
  latest?: DelegateTurnOutput,
): Promise<Partial<DelegateOutput>> {
  const result = latest?.result ?? (await state.get<string | null>(DELEGATE_STATE_KEYS.result));
  const changedFiles = (await state.get<string[]>(DELEGATE_STATE_KEYS.changedFiles)) ?? [];
  const artifacts = (await state.get<DelegateArtifact[]>(DELEGATE_STATE_KEYS.artifacts)) ?? [];
  const worktreePath = await state.get<string | null>(DELEGATE_STATE_KEYS.worktreePath);
  const worktreeBranch = await state.get<string | null>(DELEGATE_STATE_KEYS.worktreeBranch);
  const worktreeCleanup = await state.get<DelegateWorktreeCleanupDetails | null>(
    DELEGATE_STATE_KEYS.worktreeCleanup,
  );

  return {
    ...(result === undefined || result === null ? {} : { result }),
    ...(changedFiles.length === 0 ? {} : { changedFiles }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(worktreePath === undefined || worktreePath === null ? {} : { worktreePath }),
    ...(worktreeBranch === undefined || worktreeBranch === null ? {} : { worktreeBranch }),
    ...(worktreeCleanup === undefined || worktreeCleanup === null ? {} : { worktreeCleanup }),
  };
}

async function finalDone(output: DelegateOutput) {
  const cleanup = await cleanupManagedWorktree(output.status);
  const finalOutput = cleanup === undefined ? output : { ...output, worktreeCleanup: cleanup };
  return done(finalOutput, { message: delegateTerminalMessage(finalOutput) });
}

function delegateTerminalMessage(output: DelegateOutput): string {
  const lines = [
    `Delegate ${output.status}: ${output.summary}`,
    `Turns: ${output.turns}; questions asked: ${output.questionsAsked}`,
  ];
  if (output.changedFiles && output.changedFiles.length > 0) {
    lines.push(`Changed files: ${output.changedFiles.join(", ")}`);
  }
  if (output.worktreePath) {
    lines.push(`Worktree: ${output.worktreePath}`);
  }
  if (output.worktreeBranch) {
    lines.push(`Worktree branch: ${output.worktreeBranch}`);
  }
  if (output.worktreeCleanup) {
    lines.push(
      `Worktree cleanup: ${output.worktreeCleanup.status} (${output.worktreeCleanup.requested})${
        output.worktreeCleanup.reason ? ` - ${output.worktreeCleanup.reason}` : ""
      }`,
    );
  }
  if (output.result?.trim()) {
    lines.push(output.result.trim());
  }
  return lines.join("\n");
}

async function requiredState<T>(key: string): Promise<T> {
  const value = await state.get<T>(key);
  if (value === undefined || value === null) {
    throw new Error(`Delegate state is missing required key: ${key}`);
  }
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
