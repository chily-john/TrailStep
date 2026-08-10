import type { TrailStepCliPrompts } from "../command.types.js";

export type AgentConfigSaveContext =
  | { readonly kind: "named-agent-create"; readonly name: string }
  | { readonly kind: "named-agent-edit"; readonly name: string }
  | { readonly kind: "workflow-role-dash"; readonly workflowId: string; readonly roleName: string }
  | {
      readonly kind: "workflow-role-ref";
      readonly workflowId: string;
      readonly roleName: string;
      readonly ref: string;
    }
  | {
      readonly kind: "workflow-role-inline";
      readonly workflowId: string;
      readonly roleName: string;
    };

export type SaveConfirmOutcome =
  | "save-original"
  | "create-new-agent"
  | "detach-one-off"
  | "save-as-one-off"
  | "save-as-new-permanent-agent"
  | "discard";

export interface SaveConfirmRequest {
  readonly context: AgentConfigSaveContext;
  readonly prompts: TrailStepCliPrompts;
}

export async function confirmAgentConfigSave(
  request: SaveConfirmRequest,
): Promise<SaveConfirmOutcome> {
  const choices = choicesForSaveContext(request.context);
  const answer = await request.prompts.select(labelForSaveContext(request.context), choices);
  return outcomeForChoice(answer);
}

function labelForSaveContext(context: AgentConfigSaveContext): string {
  if (context.kind === "named-agent-create") {
    return `Save new agent ${context.name}?`;
  }
  if (context.kind === "named-agent-edit") {
    return `Save agent config changes for agent ${context.name}?`;
  }
  if (context.kind === "workflow-role-ref") {
    return `Save changes from workflow ${context.workflowId} role ${context.roleName} ref ${context.ref}?`;
  }
  return `Save agent config changes for workflow ${context.workflowId} role ${context.roleName}?`;
}

function choicesForSaveContext(context: AgentConfigSaveContext): readonly string[] {
  if (context.kind === "named-agent-create") {
    return ["Save as new permanent agent", "Discard"];
  }
  if (context.kind === "named-agent-edit") {
    return ["Save to original", "Create new agent", "Discard"];
  }
  if (context.kind === "workflow-role-ref") {
    return [
      "Save to original (shared, affects every other referrer)",
      "Create new agent (fork — only this role repoints)",
      "Save as just a workflow agent (detach to one-off)",
      "Discard",
    ];
  }
  if (context.kind === "workflow-role-inline") {
    return ["Save to original (update one-off in place)", "Create new agent", "Discard"];
  }
  return ["Save as new permanent agent", "Save as one-off", "Discard"];
}

function outcomeForChoice(choice: string): SaveConfirmOutcome {
  if (choice.startsWith("Save to original")) return "save-original";
  if (choice.startsWith("Create new agent")) return "create-new-agent";
  if (choice.startsWith("Save as just a workflow agent")) return "detach-one-off";
  if (choice === "Save as one-off") return "save-as-one-off";
  if (choice === "Save as new permanent agent") return "save-as-new-permanent-agent";
  return "discard";
}
