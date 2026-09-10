import { defineWorkflow } from "@trailstep/authoring";
import {
  type DelegateInput,
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

export const delegate = defineWorkflow<DelegateInput, DelegateOutput>({
  id: "delegate",
  description: "Runs delegated focused work while preserving run-local continuity.",
  inputShape: delegateInputShape,
  outputShape: delegateOutputShape,
  agents: {
    delegateAgent: {
      size: "medium",
      thinking: "medium",
      description: "Runs delegated focused work while preserving run-local continuity.",
    },
  },
  start(input) {
    return initializeDelegateStep(input);
  },
});
