import { defineWorkflow } from "@trailstep/authoring";
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
};

export function defineDelegateWorkflow(config: DelegateWorkflowConfig) {
  return defineWorkflow<DelegateInput, DelegateOutput>({
    id: config.id,
    description: config.description,
    skill: delegateSkill(config),
    inputShape: delegateInputShape,
    outputShape: delegateOutputShape,
    agents: {
      delegateAgent: {
        size: config.agentSize ?? "medium",
        thinking: config.agentThinking ?? "medium",
        description: config.description,
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
  description: "Runs delegated focused work while preserving run-local continuity.",
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
  description: "Runs read-oriented delegated exploration while preserving run-local continuity.",
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
  description: "Runs narrow, low-cost read-only exploration while preserving run-local continuity.",
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
  description: "Scouts the codebase to identify the few files or seams likely needing edits.",
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
  description: "Runs delegated review work while preserving run-local continuity.",
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
  description: "Runs delegated implementation work while preserving run-local continuity.",
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
  description: "Runs strict localized implementation work for mechanical changes.",
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
  description: "Runs complex implementation, algorithmic work, or cross-file refactors.",
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
  description: "Diagnoses and fixes validation, lint, test, or runtime failures.",
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
  description: "Produces exact structured output for schema-bound handoffs.",
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
