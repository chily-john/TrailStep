export function buildWorkingAgentPrompt(options: {
  readonly prompt: string;
  readonly outputFile: string;
  readonly outputSchema: Record<string, unknown>;
  readonly captureMode?: "json" | "raw-text";
}): string {
  if (options.captureMode === "raw-text") {
    return [
      "# TrailStep working-agent task",
      "",
      "Run the task described below and write the document content to the output file.",
      "Print the document content directly as your entire response — no JSON wrapper, no surrounding commentary, no markdown fences unless they are literally part of the document content itself.",
      "",
      `Output file: ${options.outputFile}`,
      "",
      "## Original prompt",
      "",
      options.prompt,
      "",
    ].join("\n");
  }

  return [
    "# TrailStep working-agent task",
    "",
    "Run the task described below and write exactly one JSON object to the output file.",
    "Do not write prose, markdown fences, or multiple JSON values to the output file.",
    "",
    `Output file: ${options.outputFile}`,
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
