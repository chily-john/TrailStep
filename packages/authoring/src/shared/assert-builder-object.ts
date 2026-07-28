export function assertBuilderObject(
  value: unknown,
  builderName: string,
): asserts value is { readonly id: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${builderName} requires a single object argument.`);
  }
  if (typeof (value as { readonly id?: unknown }).id !== "string") {
    throw new TypeError(`${builderName} requires an id string.`);
  }
}
