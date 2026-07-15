import { Ajv, type ErrorObject, type JSONSchemaType } from "ajv/dist/ajv.js";

import { StepKitFailureError, validationFailure } from "../shared/failure.js";
import type {
  PlainObject,
  Schema,
  ShapeInput,
  ShapeObject,
  ValidationDiagnostic,
} from "../shared/shape.types.js";

export type JsonSchemaObject = JSONSchemaType<PlainObject> | Record<string, unknown>;

const ajv = new Ajv({ allErrors: true });

export function normalizeShape<T extends PlainObject>(shapeInput: ShapeInput<T>): Schema<T> {
  if (isSchema(shapeInput)) {
    return shapeInput;
  }

  return shape<T>(shapeInput);
}

export function shape<T extends PlainObject>(shapeObject: ShapeObject): Schema<T> {
  return jsonSchema<T>({
    type: "object",
    properties: Object.fromEntries(
      Object.entries(shapeObject).map(([key, type]) => [key, { type }]),
    ),
    required: Object.keys(shapeObject),
    additionalProperties: false,
  });
}

export function jsonSchema<T extends PlainObject>(schema: JsonSchemaObject): Schema<T> {
  const validateWithAjv = ajv.compile(schema);

  return {
    validate(value: unknown): value is T {
      return validateWithAjv(value);
    },
    diagnostics(value: unknown): readonly ValidationDiagnostic[] {
      if (!isPlainObject(value)) {
        return [{ path: "/", message: "must be a plain object" }];
      }

      if (validateWithAjv(value)) {
        return [];
      }

      return diagnosticsFromAjvErrors(validateWithAjv.errors);
    },
    assert(value: unknown, label = "value"): T {
      const diagnostics = this.diagnostics(value);

      if (diagnostics.length > 0) {
        throw new StepKitFailureError(
          validationFailure(
            `${label} failed schema validation: ${formatDiagnostics(diagnostics)}`,
            { diagnostics },
          ),
        );
      }

      return value as T;
    },
    jsonSchema: schema as Record<string, unknown>,
  };
}

function isSchema<T extends PlainObject>(value: ShapeInput<T>): value is Schema<T> {
  return (
    isPlainObject(value) &&
    typeof value.validate === "function" &&
    typeof value.diagnostics === "function" &&
    typeof value.assert === "function"
  );
}

export function isPlainObject(value: unknown): value is PlainObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function diagnosticsFromAjvErrors(
  errors: ErrorObject[] | null | undefined,
): readonly ValidationDiagnostic[] {
  if (!errors || errors.length === 0) {
    return [{ path: "/", message: "is invalid" }];
  }

  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "is invalid",
  }));
}

function formatDiagnostics(diagnostics: readonly ValidationDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.path} ${diagnostic.message}`).join("; ");
}
