export function validateStructural(obj: unknown): boolean {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.schemaVersion !== "string") return false;
  if (typeof o.name !== "string" || !o.name.startsWith("trst_")) return false;
  if (typeof o.workflowRef !== "string") return false;
  if (typeof o.description !== "string") return false;
  if (typeof o.generatedBy !== "string") return false;
  return true;
}
