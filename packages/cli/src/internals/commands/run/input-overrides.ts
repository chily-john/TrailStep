import type { PlainObject, Workflow } from "@trailstep/core";
import { normalizeShape } from "@trailstep/core";
import { CliInputError } from "./load-run-input.js";
import type { InputOverride } from "./run-command.types.js";

export function applyInputOverrides(
  baseInput: PlainObject,
  overrides: readonly InputOverride[] = [],
  workflow?: Workflow,
): PlainObject {
  if (overrides.length === 0) {
    return baseInput;
  }

  const input = structuredClone(baseInput) as PlainObject;
  const rootSchema = workflowInputSchema(workflow);
  for (const override of overrides) {
    setInputPath(
      input,
      override.path,
      parseInputOverrideValue(override.rawValue, {
        schema: schemaForPath(rootSchema, override.path),
        preferLooseJson: override.kind === "set",
        source: override.source,
      }),
    );
  }

  return input;
}

export function workflowInputSchema(workflow?: Workflow): Record<string, unknown> | undefined {
  if (!workflow) {
    return undefined;
  }

  const input = workflow.inputShape ? normalizeShape(workflow.inputShape) : workflow.input;
  return input?.jsonSchema;
}

function setInputPath(target: PlainObject, rawPath: string, value: unknown): void {
  const segments = rawPath.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new CliInputError(`Invalid input path: ${rawPath}`);
  }

  let current: Record<string, unknown> = target;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }

    const existing = current[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[segment] = next;
      current = next;
      continue;
    }

    if (!isPlainObject(existing)) {
      throw new CliInputError(
        `Unable to set ${rawPath}: ${segments.slice(0, index + 1).join(".")} is not an object.`,
      );
    }

    current = existing;
  }
}

function parseInputOverrideValue(
  rawValue: string,
  options: {
    readonly schema?: Record<string, unknown>;
    readonly preferLooseJson: boolean;
    readonly source: string;
  },
): unknown {
  const type = selectSchemaType(options.schema);
  if (type === "string") {
    return rawValue;
  }

  if (type === "boolean") {
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
    throw new CliInputError(`${options.source} expects a boolean value (true or false).`);
  }

  if (type === "number" || type === "integer") {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || (type === "integer" && !Number.isInteger(parsed))) {
      throw new CliInputError(`${options.source} expects a ${type} value.`);
    }
    return parsed;
  }

  if (type === "object" || type === "array") {
    return parseJsonValue(rawValue, `${options.source} expects JSON ${type} input.`);
  }

  if (options.preferLooseJson) {
    return parseLooseJsonValue(rawValue);
  }

  return rawValue;
}

function selectSchemaType(schema: Record<string, unknown> | undefined): string | undefined {
  const rawType = schema?.type;
  if (typeof rawType === "string") {
    return rawType;
  }
  if (Array.isArray(rawType)) {
    return rawType.find((value): value is string => typeof value === "string" && value !== "null");
  }
  return undefined;
}

function schemaForPath(
  rootSchema: Record<string, unknown> | undefined,
  rawPath: string,
): Record<string, unknown> | undefined {
  let schema = rootSchema;
  for (const segment of rawPath.split(".")) {
    if (!schema) {
      return undefined;
    }
    const properties = schema.properties;
    if (!isPlainObject(properties)) {
      return undefined;
    }
    const next = properties[segment];
    if (!isPlainObject(next)) {
      return undefined;
    }
    schema = next;
  }
  return schema;
}

function parseLooseJsonValue(rawValue: string): unknown {
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue === "null") return null;
  if (rawValue.trim().startsWith("{") || rawValue.trim().startsWith("[")) {
    return parseJsonValue(rawValue, "Invalid JSON supplied to --set.");
  }
  const numeric = Number(rawValue);
  if (rawValue.trim() !== "" && Number.isFinite(numeric)) {
    return numeric;
  }
  return rawValue;
}

function parseJsonValue(rawValue: string, message: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch (error) {
    throw new CliInputError(message, { cause: error });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
