/**
 * Prompt for a built-in registry provider's working-mode invocation. Unlike
 * `buildWorkingAgentPrompt`, this never instructs the vendor CLI to write a
 * file itself: a registry provider adapter captures stdout and writes
 * `outputFile` on the runtime's behalf, so the prompt instead asks for the
 * JSON object as the model's entire final answer.
 */
export function buildProviderWorkingPrompt(options: {
  readonly prompt: string;
  readonly outputSchema: Record<string, unknown>;
  readonly captureMode?: "json" | "raw-text";
}): string {
  if (options.captureMode === "raw-text") {
    return [
      "# StepKit working-agent task",
      "",
      "Print the document content directly as your entire response — no JSON wrapper, no surrounding commentary, no markdown fences unless they are literally part of the document content itself.",
      "Do not write output to a file.",
      "",
      "## Original prompt",
      "",
      options.prompt,
      "",
    ].join("\n");
  }

  return [
    "# StepKit working-agent task",
    "",
    "Respond with exactly one JSON object as your entire final answer, and nothing else.",
    "Do not write output to a file. Do not include prose, markdown fences, or multiple JSON values in your final answer - only the JSON object itself. This instruction applies to your literal final message, not just the work you do to get there.",
    "",
    "The JSON object must match this output schema:",
    "",
    "```json",
    JSON.stringify(options.outputSchema, null, 2),
    "```",
    "",
    "## Original prompt",
    "",
    options.prompt,
    "",
  ].join("\n");
}
