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

type DelegateWorkflowConfig = {
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

function defineDelegateWorkflow(config: DelegateWorkflowConfig) {
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
    "Use as a flexible sub-agent for focused TrailStep delegate work with run-local continuity.",
  skillFocus:
    "Use for general delegated work when the parent agent wants to choose the task, mode, turn budget, and context shape explicitly.",
  defaultMode: "general",
  defaultMaxTurns: 10,
});

export const delegateExplore = defineDelegateWorkflow({
  id: "delegateExplore",
  description: "Runs read-oriented delegated exploration while preserving run-local continuity.",
  skillName: "trst-delegate-explore",
  skillDescription:
    "Use as a sub-agent for bounded read-oriented investigation and findings summaries.",
  skillFocus:
    "Explore mode is read-oriented: inspect code, commands, docs, and artifacts; summarize findings and avoid edits unless the task explicitly asks for them.",
  defaultMode: "explore",
  defaultMaxTurns: 6,
  summarize: true,
});

export const delegateReview = defineDelegateWorkflow({
  id: "delegateReview",
  description: "Runs delegated review work while preserving run-local continuity.",
  skillName: "trst-delegate-review",
  skillDescription:
    "Use as a sub-agent for focused code, plan, or change review without unnecessary edits.",
  skillFocus:
    "Review mode should inspect existing work, identify concrete issues and risks, and avoid edits unless the parent task explicitly requests a fix.",
  defaultMode: "review",
  defaultMaxTurns: 6,
  summarize: false,
});

export const delegateImplement = defineDelegateWorkflow({
  id: "delegateImplement",
  description: "Runs delegated implementation work while preserving run-local continuity.",
  skillName: "trst-delegate-implement",
  skillDescription: "Use as a sub-agent for bounded implementation tasks that may edit files.",
  skillFocus:
    "Implement mode may edit files. Make the smallest safe change, run focused checks when practical, and always report changedFiles/artifacts that were actually produced.",
  defaultMode: "implement",
  defaultMaxTurns: 12,
  summarize: false,
  agentThinking: "medium",
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
- For long context, write an input JSON file and run \`trailstep @trailstep/sub-agents#${config.id} --input-file delegate-input.json\`.
- Use unique run names for parallel delegates so their run-local state stays separate.
- Use \`cwd\` for an existing worktree or subdirectory that TrailStep should not manage. Use \`worktree.enabled=true\` when the delegate should create a managed git worktree and safely clean it up/report it.
- Do not pass both \`cwd\` and \`worktree.enabled=true\`; choose one execution location strategy.
- If a delegate asks a question, answer with \`trailstep answer <runName> parent-answer --json '{"answer":"..."}'\`, then resume with \`trailstep continue <runName>\`.
- Retry a failed turn with \`trailstep retry <workflowRef> <runName>\` when appropriate.
- Read final typed output with \`trailstep output <runName>\`; read the terminal summary with \`trailstep output <runName> --message\`.
- Package reference: \`@trailstep/sub-agents#${config.id}\`; built dist reference: \`./packages/sub-agents/dist/index.js#${config.id}\`.

This skill is intended for delegated working-agent use rather than direct end-user planning chat. Preserve the run-local memory supplied in the workflow prompt, keep work bounded to the requested turn, and return the JSON contract requested by the workflow prompt.`;
}
