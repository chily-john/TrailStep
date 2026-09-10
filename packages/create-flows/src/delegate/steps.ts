import { resolve } from "node:path";

import { done, notify, type StepFactory, state, step } from "@trailstep/authoring";
import { delegateTurnPrompt } from "./prompts.js";
import {
  type AskParentInput,
  type DelegateArtifact,
  type DelegateInput,
  type DelegateOutput,
  type DelegateTurnInput,
  type DelegateTurnOutput,
  delegateTurnOutputShape,
  type NormalizedDelegateInput,
  normalizeDelegateInput,
  type ParentAnswerOutput,
  type PrepareDelegateTurnInput,
  parentAnswerShape,
  type QuestionAnswer,
} from "./schema.js";

const MEMORY_LIMIT = 12_000;

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
} as const;

export const initializeDelegateStep = step({
  id: "initialize-delegate",
  title: "Initialize delegate",
})
  .display(({ input }) => `Delegating: ${(input as DelegateInput).task}`)
  .do(async (input: DelegateInput) => {
    const initialized = (await state.get<boolean>(DELEGATE_STATE_KEYS.initialized)) ?? false;
    if (initialized) {
      return prepareDelegateTurnStep({ turn: 1 });
    }

    const normalized = normalizeDelegateInput(input);
    const executionCwd = resolveDelegateCwd(normalized.cwd);
    const normalizedInput = { ...normalized, ...(normalized.cwd ? { cwd: executionCwd } : {}) };

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
    await state.set(DELEGATE_STATE_KEYS.worktreePath, null);

    await notify.progress("Initialized delegate memory", {
      mode: normalizedInput.mode,
      maxTurns: normalizedInput.maxTurns,
      cwd: executionCwd,
    });

    if (normalizedInput.worktree.enabled) {
      return done<DelegateOutput>({
        status: "blocked",
        summary:
          "Delegate worktree support is not implemented yet. Re-run with worktree.enabled false or provide cwd directly.",
        questionsAsked: 0,
        turns: 0,
      });
    }

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
    return done<DelegateOutput>({
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
    ...(input.worktree.enabled && input.cwd !== undefined ? { worktreePath: input.cwd } : {}),
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
      return done<DelegateOutput>({
        status: "completed",
        summary: turnOutput.summary,
        ...(await finalOptionalOutputFields(turnOutput)),
        questionsAsked,
        turns,
      });
    }

    if (turnOutput.status === "blocked") {
      const questionsAsked = (await state.get<number>(DELEGATE_STATE_KEYS.questions)) ?? 0;
      return done<DelegateOutput>({
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
        return done<DelegateOutput>({
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

function resolveDelegateCwd(cwd: string | undefined): string {
  const base = state.projectCwd ?? state.executionCwd ?? state.cwd ?? process.cwd();
  return cwd === undefined ? base : resolve(base, cwd);
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

  return {
    ...(result === undefined || result === null ? {} : { result }),
    ...(changedFiles.length === 0 ? {} : { changedFiles }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(worktreePath === undefined || worktreePath === null ? {} : { worktreePath }),
  };
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
