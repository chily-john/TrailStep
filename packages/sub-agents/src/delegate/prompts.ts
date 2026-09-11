import { list, promptSections, section } from "@trailstep/authoring";
import type { DelegateMode, DelegateTurnInput } from "./schema.js";

export function delegateTurnPrompt({ input }: { readonly input: DelegateTurnInput }): string {
  return promptSections(
    section(
      "Role",
      "You are a continued delegate agent working inside one TrailStep run. Preserve continuity from the run-local memory below, but do not assume or use memory from any separate run.",
    ),
    section("Original task", input.task),
    section("Original context", input.context),
    section("Mode", `${input.mode}: ${modeGuidance(input.mode)}`),
    section(
      "Execution location",
      [
        `CWD/worktree path: ${input.worktreePath ?? input.executionCwd}`,
        "Honor this directory for any project inspection or file edits.",
      ].join("\n"),
    ),
    section("Accumulated run-local memory summary", input.memory || "No prior delegate memory."),
    section("Previous questions and parent/human answers", formatQuestionsAndAnswers(input)),
    section("Latest summary", input.latestSummary ?? "No prior summary."),
    section(
      "Current turn",
      [
        `Turn: ${input.turn} of ${input.maxTurns}`,
        `Summarize mode: ${String(input.summarize)}`,
      ].join("\n"),
    ),
    section(
      "Instructions",
      list([
        "Do one focused turn of delegated work; keep the work bounded and observable.",
        "Use the run-local memory summary and previous Q/A as continuity, not an unlimited transcript.",
        "If you can finish the task now, return status `completed` with a concise summary and final result.",
        "If more delegated work is needed and no parent answer is required, return status `continue` and a memory patch for the next turn.",
        "If blocked on a parent/human decision, return status `question`, include exactly one clear question, and summarize why it is needed.",
        "If the task cannot proceed safely, return status `blocked` with the reason in the summary/result.",
        "When you learn durable facts for this run, include a compact `memoryPatch`; do not copy large transcripts, files, or diffs.",
        "Report changed files and artifacts only when you actually changed or produced them.",
      ]),
    ),
    section("Exact output contract", outputContract),
  );
}

function modeGuidance(mode: DelegateMode): string {
  switch (mode) {
    case "explore":
      return "investigate, summarize findings, and avoid code changes unless explicitly needed.";
    case "implement":
      return "make the smallest safe implementation progress and report changed files.";
    case "review":
      return "review existing work, identify issues, and avoid unnecessary edits.";
    case "general":
      return "use judgment to complete the delegated task with focused, bounded work.";
  }
}

function formatQuestionsAndAnswers(input: DelegateTurnInput): string {
  if (input.questionsAndAnswers.length === 0) {
    return "No parent/human questions have been asked in this run.";
  }

  return input.questionsAndAnswers
    .map((item, index) =>
      [`${index + 1}. Question: ${item.question}`, `   Answer: ${item.answer}`].join("\n"),
    )
    .join("\n");
}

const outputContract = `Return the structured JSON object requested by the wrapper.

Status meanings:
- completed: the delegated task is finished; include result when useful.
- continue: more bounded work is needed in another turn; include memoryPatch for durable continuity.
- question: parent/human input is required; include exactly one clear question.
- blocked: the task cannot proceed safely; summarize why and include result details when useful.

Only report changedFiles/artifacts that you actually changed or produced.`;
