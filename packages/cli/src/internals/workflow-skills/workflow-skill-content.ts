import {
  normalizeShape,
  type PlainObject,
  type Schema,
  type ShapeInput,
  type Workflow,
} from "@trailstep/core";

export type WorkflowSkillMetadata = Workflow;

export interface WorkflowSkillContentInput {
  readonly registeredRef: string;
  readonly namespace: string;
  readonly name: string;
  readonly description?: string;
  readonly workflow?: WorkflowSkillMetadata;
  /**
   * Set for skills of workflow exports with no registry entry (for example new
   * workflow exports of an already-installed workflow package). Untracked skills
   * run the workflow through its package bundle ref instead of a registered ref.
   */
  readonly untracked?: boolean;
}

export interface WorkflowSkillContent {
  readonly skillName: string;
  readonly markdown: string;
}

export function generateWorkflowSkillContent(
  input: WorkflowSkillContentInput,
): WorkflowSkillContent {
  const skillName = workflowSkillName(input.namespace, input.name);
  const isRegistered = input.untracked !== true;
  const registeredRef = isRegistered ? `${input.namespace}/${input.name}` : input.registeredRef;
  const workflowSkill = normalizeWorkflowSkill(input.workflow?.skill);
  const inputMode = classifyWorkflowInput(input.workflow);
  const generatedInstructions = generatedWorkflowSkillInstructionLines({
    inputMode,
    registeredRef,
    skillName,
    sourceRef: input.registeredRef,
    isRegistered,
  });
  const customMarkdown = workflowSkill.markdown;
  const baseDescription =
    workflowSkill.description ??
    input.workflow?.description ??
    input.description ??
    `Run the TrailStep workflow "${registeredRef}".`;
  const description = workflowSkillDescription(input.namespace, baseDescription);
  const generatedFrontmatter = [
    "---",
    `name: ${skillName}`,
    `description: ${frontmatterString(description)}`,
    "---",
    "",
  ];

  if (customMarkdown !== undefined && customMarkdown.trim().length > 0) {
    const customBody = customMarkdown.trimEnd();
    const contentLines = startsWithYamlFrontmatter(customBody)
      ? [customBody, ""]
      : [...generatedFrontmatter, customBody, ""];

    return {
      skillName,
      markdown: [...contentLines, ...generatedInstructions].join("\n"),
    };
  }

  return {
    skillName,
    markdown: [
      ...generatedFrontmatter,
      ...customSkillInstructionLines(workflowSkill.instructions),
      ...generatedInstructions,
    ].join("\n"),
  };
}

export function workflowSkillName(_namespace: string, name: string): string {
  return `trst-${sanitizeSkillNamePart(name) || "workflow"}`;
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

function generatedWorkflowSkillInstructionLines(input: {
  readonly inputMode: WorkflowInputMode;
  readonly registeredRef: string;
  readonly skillName: string;
  readonly sourceRef: string;
  readonly isRegistered: boolean;
}): readonly string[] {
  return [
    input.isRegistered
      ? `Run the registered TrailStep workflow \`${input.registeredRef}\`.`
      : `Run the TrailStep workflow \`${input.registeredRef}\` through its package bundle ref.`,
    "",
    ...inputInstructions(input),
    `${input.isRegistered ? "Registered workflow source" : "Workflow source"}: \`${input.sourceRef}\``,
    "",
  ];
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
      "Prepare workflow input JSON that matches this normalized schema:",
      "",
      "```json",
      JSON.stringify(input.inputMode.jsonSchema, null, 2),
      "```",
      "",
      "If validation fails, fix the JSON to match the schema before retrying.",
      "",
      "When this skill is invoked, prefer piping one-shot JSON on stdin:",
      "",
      "```bash",
      `printf '%s\\n' '<json-object>' | trailstep ${input.registeredRef} --input-file -`,
      "```",
      "",
      `For reusable/debuggable input, save the JSON at \`${inputFile}\` and run:`,
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
    "When this skill is invoked, prefer piping the JSON wrapper on stdin:",
    "",
    "```bash",
    `printf '%s\\n' '<json-object>' | trailstep ${input.registeredRef} --input-file -`,
    "```",
    "",
    `For reusable/debuggable input, save the JSON wrapper at \`${inputFile}\` and run:`,
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

function customSkillInstructionLines(instructions: string | undefined): readonly string[] {
  const trimmed = instructions?.trim();
  return trimmed === undefined || trimmed.length === 0 ? [] : [trimmed, ""];
}

function normalizeWorkflowSkill(skill: WorkflowSkillMetadata["skill"]): {
  readonly description?: string;
  readonly instructions?: string;
  readonly markdown?: string;
} {
  if (typeof skill === "string") return { markdown: skill };
  return skill ?? {};
}

function workflowSkillDescription(namespace: string, description: string): string {
  const origin = namespace.trim();
  return origin.length > 0 ? `[${origin}] ${description}` : description;
}

function frontmatterString(value: string): string {
  return JSON.stringify(value);
}

function startsWithYamlFrontmatter(markdown: string): boolean {
  return markdown.startsWith("---\n") || markdown.startsWith("---\r\n");
}

function sanitizeSkillNamePart(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}
