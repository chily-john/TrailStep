/** Quotes a value for display in a shell command when it contains whitespace or quotes. */
export function quoteForShell(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
