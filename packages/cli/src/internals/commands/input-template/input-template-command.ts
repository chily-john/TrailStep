import type { Workflow } from "@trailstep/core";
import type { CliCommand, CliCommandContext } from "../../command.types.js";
import { CliUsageError } from "../../command.types.js";
import { resolveWorkflowReference } from "../../workflow-resolution/workflow-resolution.js";
import { workflowInputSchema } from "../run/input-overrides.js";

interface InputTemplateArgs {
  readonly workflowId: string;
}

export const inputTemplateCommand: CliCommand<InputTemplateArgs> = {
  name: "input-template",
  parseArgs(argv) {
    if (argv.length !== 2 || argv[0] !== "input-template") {
      throw new CliUsageError("Usage: trailstep input-template <workflow-ref>");
    }
    return { workflowId: argv[1] as string };
  },
  async run(args: InputTemplateArgs, context: CliCommandContext): Promise<number> {
    const resolvedWorkflow = await resolveWorkflowReference(args.workflowId, {
      cwd: context.cwd,
      homeDir: context.homeDir,
    });

    if (!resolvedWorkflow) {
      context.io.writeError(
        `Workflow not found: ${args.workflowId}. Run trailstep workflows to see available workflows.`,
      );
      return 1;
    }

    context.io.writeLine(
      JSON.stringify(inputTemplateForWorkflow(resolvedWorkflow.workflow), null, 2),
    );
    return 0;
  },
};

export function inputTemplateForWorkflow(workflow: Workflow): Record<string, unknown> {
  const schema = workflowInputSchema(workflow);
  const template = templateForSchema(schema);
  return isPlainObject(template) ? template : {};
}

function templateForSchema(schema: Record<string, unknown> | undefined): unknown {
  if (!schema) {
    return {};
  }

  if ("default" in schema) {
    return structuredClone(schema.default);
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return structuredClone(enumValues[0]);
  }

  const type = selectSchemaType(schema);
  if (type === "object") {
    const properties = schema.properties;
    if (!isPlainObject(properties)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(properties).map(([key, propertySchema]) => [
        key,
        isPlainObject(propertySchema) ? templateForSchema(propertySchema) : null,
      ]),
    );
  }

  if (type === "array") {
    return [];
  }

  if (type === "boolean") {
    return false;
  }

  if (type === "number" || type === "integer") {
    return 0;
  }

  if (type === "string") {
    return "";
  }

  return null;
}

function selectSchemaType(schema: Record<string, unknown>): string | undefined {
  const rawType = schema.type;
  if (typeof rawType === "string") {
    return rawType;
  }
  if (Array.isArray(rawType)) {
    return rawType.find((value): value is string => typeof value === "string" && value !== "null");
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
