import { type AgentExecutionConfig, defineWorkflow } from "@trailstep/authoring";
import {
  type DelegateInput,
  type DelegateMode,
  type DelegateOutput,
  delegateInputShape,
  delegateOutputShape,
} from "./schema.js";
import { initializeDelegateStep } from "./steps.js";

export type {
  DelegateArtifact,
  DelegateInput,
  DelegateMode,
  DelegateOutput,
  DelegateTurnOutput,
  DelegateTurnStatus,
  DelegateWorktreeInput,
} from "./schema.js";

export type DelegateWorkflowConfig = {
  readonly id: string;
  readonly description: string;
  readonly skillName: string;
  readonly skillDescription: string;
  readonly skillFocus: string;
  readonly defaultMode: DelegateMode;
  readonly defaultMaxTurns: number;
  readonly summarize?: boolean;
  readonly agentSize?: "small" | "medium" | "large";
  readonly agentThinking?: "low" | "medium" | "high";
  /**
   * Lean execution context for the delegate's working agent. Defaults to
   * {@link LEAN_DELEGATE_EXECUTION}: all tools, no skills, no MCP, no
   * extensions, with the project's context files loaded. Only rendered for
   * providers whose manifest declares a hygiene capability mapping; other
   * providers keep their current behavior.
   */
  readonly execution?: AgentExecutionConfig;
};

/**
 * Default lean execution context applied to every delegate workflow.
 *
 * The delegate is lean about the things a sub-agent rarely needs: no skills,
 * no MCP, no extension loading, all tools. Context files are NOT pinned here
 * — the delegate inherits the framework default (context files loaded), so
 * the repository's own instructions reach it, and a project can change that
 * through the `settings.execution` config block.
 *
 * For pi this renders `--no-skills --no-mcp --no-extensions` and no
 * context-file flag. Note that `contextFiles: "project-only"` and `false`
 * both render `--no-context-files` on pi (which disables all discovery)
 * since no CLI offers a project-only flag.
 */
export const LEAN_DELEGATE_EXECUTION: AgentExecutionConfig = {
  tools: "*",
  skills: [],
  mcp: false,
  extensions: [],
};

/**
 * Shared sentence fragments for the delegate workflow descriptions. The
 * description of a workflow is what a calling model sees in the generated
 * per-workflow MCP tool JSON, so it has to say what `mode` and `maxTurns`
 * do and how a delegate question is answered.
 */
const MODE_SENTENCE =
  "`mode` selects the delegate behavior (explore = read-only investigation, implement = edits files, review = review, general = judgement)";
const MAX_TURNS_SENTENCE = "`maxTurns` bounds the number of turns";
const QUESTION_SENTENCE =
  "a delegate that needs a decision returns a question, which you answer with `trst_answer` and then continue the run with `trst_resume`";

export function defineDelegateWorkflow(config: DelegateWorkflowConfig) {
  return defineWorkflow<DelegateInput, DelegateOutput>({
    id: config.id,
    description: config.description,
    skill: delegateSkill(config), // deprecated but preserved for compatibility
    inputShape: delegateInputShape,
    outputShape: delegateOutputShape,
    agents: {
      delegateAgent: {
        size: config.agentSize ?? "medium",
        thinking: config.agentThinking ?? "medium",
        description: config.description,
        execution: config.execution ?? LEAN_DELEGATE_EXECUTION,
      },
    },
    start(input) {
      return initializeDelegateStep(input, {
        mode: config.defaultMode,
        maxTurns: config.defaultMaxTurns,
        ...(config.summarize === undefined ? {} : { summarize: config.summarize }),
      });
    },
  });
}

export const delegate = defineDelegateWorkflow({
  id: "delegate",
  description: `Runs one bounded delegated task in a separate working agent while preserving run-local continuity. ${MODE_SENTENCE}, ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate",
  skillDescription:
    "Use when you need to delegate a single bounded task and want to choose mode, turn budget, and context shape explicitly. General-purpose delegate for focused work.",
  skillFocus:
    "Use for general delegated work when the parent agent wants to choose the task, mode, turn budget, and context shape explicitly. Prefer the specialized explore, implement, review, or debugger variants when they fit. If you have 2+ independent tasks, use trst-delegate-parallel instead of calling this sequentially.",
  defaultMode: "general",
  defaultMaxTurns: 10,
});

export const delegateExplore = defineDelegateWorkflow({
  id: "delegateExplore",
  description: `Runs a read-only delegated exploration (explore mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-explore",
  skillDescription:
    "Use when you need to investigate the codebase, understand how code works, find where something lives, or trace a flow. Read-only exploration that summarizes findings without editing files.",
  skillFocus:
    "Explore mode is read-oriented: when you need to investigate the codebase, inspect code, commands, docs, and artifacts; summarize findings and avoid edits unless the task explicitly asks for them. If you have 2+ independent exploration questions, use trst-delegate-parallel instead of calling this sequentially.",
  defaultMode: "explore",
  defaultMaxTurns: 6,
  summarize: true,
});

export const delegateSimpleExplore = defineDelegateWorkflow({
  id: "delegateSimpleExplore",
  description: `Runs a narrow, low-cost read-only delegated lookup (explore mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-simple-explore",
  skillDescription:
    "Use when you need a quick low-cost answer to a narrow repo question like where is X, what calls Y, or what does this file do. Read-only single-area lookup.",
  skillFocus:
    "Simple explore is read-only and narrow: when you need a quick answer to a focused repo question, inspect one area, summarize concise findings, and avoid edits. If you have 2+ independent lookup questions, use trst-delegate-parallel instead of calling this sequentially.",
  defaultMode: "explore",
  defaultMaxTurns: 4,
  summarize: true,
  agentSize: "small",
  agentThinking: "low",
});

export const delegateArchitectPlanner = defineDelegateWorkflow({
  id: "delegateArchitectPlanner",
  description: `Scouts the codebase to identify the few files or seams likely needing edits (explore mode by default), without changing them. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-architect-planner",
  skillDescription:
    "Use when you have a bug report or feature request and need to map it to the 3-4 files or seams most likely to need edits before implementing. Read-only scouting, no code changes.",
  skillFocus:
    "Architect planner is read-only: when you need to plan before changing files, grep/read the repo, identify the 3-4 files or seams most likely to need edits, explain why, and do not write code.",
  defaultMode: "explore",
  defaultMaxTurns: 6,
  summarize: true,
  agentSize: "medium",
  agentThinking: "medium",
});

export const delegateReview = defineDelegateWorkflow({
  id: "delegateReview",
  description: `Runs a delegated review of existing code, a plan, or a diff (review mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-review",
  skillDescription:
    "Use when you need to review existing code, a plan, or a diff for concrete issues and risks. Inspects without editing unless a fix is explicitly requested.",
  skillFocus:
    "Review mode: when you need a focused review of existing work, inspect it, identify concrete issues and risks, and avoid edits unless the parent task explicitly requests a fix. If you have 2+ independent reviews, use trst-delegate-parallel instead of calling this sequentially.",
  defaultMode: "review",
  defaultMaxTurns: 6,
  summarize: false,
});

export const delegateImplement = defineDelegateWorkflow({
  id: "delegateImplement",
  description: `Runs delegated implementation work that edits files (implement mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-implement",
  skillDescription:
    "Use when you need to change files to implement a bounded fix or feature. Makes edits, runs focused checks when practical, and reports changed files.",
  skillFocus:
    "Implement mode may edit files: when you need to change files, make the smallest safe change, run focused checks when practical, and always report changedFiles/artifacts that were actually produced. If you have 2+ independent file changes, use trst-delegate-parallel instead of calling this sequentially.",
  defaultMode: "implement",
  defaultMaxTurns: 12,
  summarize: false,
  agentThinking: "medium",
});

export const delegateQuickImplementor = defineDelegateWorkflow({
  id: "delegateQuickImplementor",
  description: `Runs strict, localized implementation work for mechanical changes (implement mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-quick-implementor",
  skillDescription:
    "Use when instructions are already concrete and you need strict localized boilerplate edits with no architecture decisions. Mechanical typist that edits files.",
  skillFocus:
    "Quick implementor is the typist: when the plan is already concrete and you need to change files, follow instructions, make localized edits only, avoid broad architecture decisions, run focused checks when practical, and report changedFiles. If you have 2+ independent mechanical edits, use trst-delegate-parallel instead of calling this sequentially.",
  defaultMode: "implement",
  defaultMaxTurns: 8,
  summarize: false,
  agentSize: "medium",
  agentThinking: "medium",
});

export const delegateSmartImplementor = defineDelegateWorkflow({
  id: "delegateSmartImplementor",
  description: `Runs complex implementation, algorithmic work, or cross-file refactors (implement mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-smart-implementor",
  skillDescription:
    "Use when you need complex cross-file refactoring, algorithmic work, or interconnected system changes. Heavy-lifter that edits files and keeps scope bounded.",
  skillFocus:
    "Smart implementor is the heavy-lifter: when you need complex logic, cross-file refactors, algorithms, or non-trivial systems, handle the interconnected changes, keep scope bounded, and report changedFiles. If you have 2+ independent complex changes, use trst-delegate-parallel instead of calling this sequentially.",
  defaultMode: "implement",
  defaultMaxTurns: 14,
  summarize: false,
  agentSize: "large",
  agentThinking: "high",
});

export const delegateRelentlessDebugger = defineDelegateWorkflow({
  id: "delegateRelentlessDebugger",
  description: `Diagnoses and fixes validation, lint, test, or runtime failures (implement mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-relentless-debugger",
  skillDescription:
    "Use when lint, typecheck, tests, or runtime are failing and you need to diagnose stack traces or diagnostics and fix them iteratively. Preserves intent while editing files.",
  skillFocus:
    "Relentless debugger is the fixer: when validation, lint, tests, or runtime fail and you need to change files to fix them, consume diagnostics, preserve the intended change, fix failures iteratively, and avoid redesign unless required by the failure evidence.",
  defaultMode: "implement",
  defaultMaxTurns: 12,
  summarize: false,
  agentSize: "large",
  agentThinking: "high",
});

export const delegateSchemaFormatter = defineDelegateWorkflow({
  id: "delegateSchemaFormatter",
  description: `Produces exact structured output for schema-bound handoffs (general mode by default) in a separate working agent while preserving run-local continuity. ${MAX_TURNS_SENTENCE}, and ${QUESTION_SENTENCE}.`,
  skillName: "trst-delegate-schema-formatter",
  skillDescription:
    "Use when you need exact JSON, XML, or schema-constrained output for a handoff. Formatting-only, prioritizes exact structure over prose.",
  skillFocus:
    "Schema formatter is the translator: when you need exact structured output, prioritize the requested JSON/XML/schema structure, avoid extra prose, and do not perform broad implementation work unless explicitly requested.",
  defaultMode: "general",
  defaultMaxTurns: 4,
  summarize: false,
  agentSize: "small",
  agentThinking: "low",
});

function delegateSkill(config: DelegateWorkflowConfig): string {
  return `---
name: ${config.skillName}
description: ${config.skillDescription}
x-trailstep-user-facing: false
---
# TrailStep ${config.id} workflow

${config.skillFocus}

Use this workflow as a parent-agent/delegate tool when a parent agent needs bounded work in a repository. The delegate keeps continuity only inside one TrailStep run; separate runs do not share memory.

## Parent-agent usage

- For simple tasks, pass direct flags: \`trailstep @trailstep/sub-agents#${config.id} --task "..."\`.
- For one-shot JSON, pipe it to \`trailstep @trailstep/sub-agents#${config.id} --input-file -\`; for long/reusable context, write an input JSON file and run \`trailstep @trailstep/sub-agents#${config.id} --input-file delegate-input.json\`.
- Use unique run names for parallel delegates so their run-local state stays separate.
- Use \`cwd\` for an existing worktree or subdirectory that TrailStep should not manage. Use \`worktree.enabled=true\` when the delegate should create a managed git worktree and safely clean it up/report it.
- Do not pass both \`cwd\` and \`worktree.enabled=true\`; choose one execution location strategy.
- If a delegate asks a question, answer with \`trailstep answer <runName> parent-answer --json '{"answer":"..."}'\`, then resume with \`trailstep continue <runName>\`.
- Retry a failed turn with \`trailstep retry <workflowRef> <runName>\` when appropriate.
- Read final typed output with \`trailstep output <runName>\`; read the terminal summary with \`trailstep output <runName> --message\`.
- Package reference: \`@trailstep/sub-agents#${config.id}\`; built dist reference: \`./packages/sub-agents/dist/index.js#${config.id}\`.

This skill is intended for delegated working-agent use rather than direct end-user planning chat. Preserve the run-local memory supplied in the workflow prompt, keep work bounded to the requested turn, and return the JSON contract requested by the workflow prompt.`;
}
