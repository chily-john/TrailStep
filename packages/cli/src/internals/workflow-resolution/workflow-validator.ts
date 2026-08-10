import type { Workflow } from "@trailstep/core";

export function isWorkflow(value: unknown): value is Workflow {
  if (!isPlainObject(value)) {
    return false;
  }

  const inputShape = value.inputShape ?? value.input;
  const outputShape = value.outputShape ?? value.output;

  return (
    typeof value.id === "string" &&
    (inputShape === undefined || isShapeInput(inputShape)) &&
    (outputShape === undefined || isShapeInput(outputShape)) &&
    typeof value.start === "function"
  );
}

function isShapeInput(value: unknown): boolean {
  return isSchemaLike(value) || isSimpleShapeObject(value);
}

function isSchemaLike(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.validate === "function" &&
    typeof value.diagnostics === "function" &&
    typeof value.assert === "function"
  );
}

function isSimpleShapeObject(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Object.values(value).every(
      (shapeType) => shapeType === "string" || shapeType === "number" || shapeType === "boolean",
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
