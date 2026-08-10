import {
  normalizeShape,
  type PlainObject,
  type Schema,
  type ShapeInput,
  type Workflow,
} from "@trailstep/core";

export type WorkflowSkillMetadata = Workflow & { readonly description?: string };

export interface WorkflowSkillContentInput {
  readonly registeredRef: string;
  readonly namespace: string;
  readonly name: string;
  readonly description?: string;
  readonly workflow?: WorkflowSkillMetadata;
}

export interface WorkflowSkillContent {
  readonly skillName: string;
  readonly markdown: string;
}

export function generateWorkflowSkillContent(
  input: WorkflowSkillContentInput,
): WorkflowSkillContent {
  const skillName = workflowSkillName(input.namespace, input.name);
  const registeredRef = `${input.namespace}/${input.name}`;
  const baseDescription =
    input.workflow?.description ??
    input.description ??
    `Run the TrailStep workflow "${registeredRef}".`;
  const description = workflowSkillDescription(input.namespace, baseDescription);
  const inputMode = classifyWorkflowInput(input.workflow);

  return {
    skillName,
    markdown: [
      "---",
      `name: ${skillName}`,
      `description: ${frontmatterString(description)}`,
      "---",
      "",
      `Run the registered TrailStep workflow \`${registeredRef}\`.`,
      "",
      ...inputInstructions({ inputMode, registeredRef, skillName }),
      `Registered workflow source: \`${input.registeredRef}\``,
      "",
    ].join("\n"),
  };
}

export function workflowSkillName(_namespace: string, name: string): string {
  return `sk-${sanitizeSkillNamePart(name) || "workflow"}`;
}

type WorkflowInputMode =
  | { readonly kind: "none" }
  | { readonly kind: "inputShape"; readonly jsonSchema: Record<string, unknown> }
  | { readonly kind: "inputSchema"; readonly jsonSchema?: Record<string, unknown> };

function classifyWorkflowInput(workflow: WorkflowSkillMetadata | undefined): WorkflowInputMode {
  if (workflow?.inputShape !== undefined) {
    return {
      kind: "inputShape",
      jsonSchema: normalizeShape(workflow.inputShape as ShapeInput<PlainObject>).jsonSchema,
    };
  }

  if (workflow?.input !== undefined) {
    return { kind: "inputSchema", jsonSchema: schemaJsonSchema(workflow.input) };
  }

  return { kind: "none" };
}

function inputInstructions(input: {
  readonly inputMode: WorkflowInputMode;
  readonly registeredRef: string;
  readonly skillName: string;
}): readonly string[] {
  const inputFile = `.trailstep/inputs/${input.skillName}-input.json`;

  if (input.inputMode.kind === "none") {
    return [
      "This workflow declares no input. Do not export conversation context or create an input file.",
      "",
      "When this skill is invoked, run:",
      "",
      "```bash",
      `trailstep ${input.registeredRef}`,
      "```",
      "",
    ];
  }

  if (input.inputMode.kind === "inputShape") {
    return [
      `Create workflow input JSON at \`${inputFile}\` that matches this normalized schema:`,
      "",
      "```json",
      JSON.stringify(input.inputMode.jsonSchema, null, 2),
      "```",
      "",
      "If validation fails, fix the JSON file to match the schema before retrying.",
      "",
      "When this skill is invoked, run:",
      "",
      "```bash",
      `trailstep ${input.registeredRef} --input-file ${inputFile}`,
      "```",
      "",
    ];
  }

  const contextFile = `.trailstep/inputs/${input.skillName}-context.md`;
  const lines = [
    `Export dense conversation/session context to \`${contextFile}\` before invoking this workflow.`,
    `Create \`${inputFile}\` containing an object such as:`,
    "",
    "```json",
    `{ "sessionFile": "${contextFile}" }`,
    "```",
    "",
  ];

  if (input.inputMode.jsonSchema !== undefined) {
    lines.push(
      "The workflow input JSON schema is:",
      "",
      "```json",
      JSON.stringify(input.inputMode.jsonSchema, null, 2),
      "```",
      "",
    );
  }

  lines.push(
    "If validation fails, preserve the context markdown and fix the JSON wrapper before retrying.",
    "",
    "When this skill is invoked, run:",
    "",
    "```bash",
    `trailstep ${input.registeredRef} --input-file ${inputFile}`,
    "```",
    "",
  );

  return lines;
}

function schemaJsonSchema(schema: Schema<PlainObject>): Record<string, unknown> | undefined {
  return schema.jsonSchema;
}

function workflowSkillDescription(namespace: string, description: string): string {
  const origin = namespace.trim();
  return origin.length > 0 ? `[${origin}] ${description}` : description;
}

function frontmatterString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeSkillNamePart(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}
