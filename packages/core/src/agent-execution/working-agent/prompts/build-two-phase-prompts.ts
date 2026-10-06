/**
 * Two-phase working-agent prompts (Architecture B).
 *
 * Phase 1 (work): the agent does the task and reports naturally. The prompt
 * deliberately says nothing about output files, JSON, or schemas — mentioning
 * them here is what causes long implement turns to emit domain JSON instead
 * of the wrapper envelope.
 *
 * Phase 2 (format): a pinned same-session follow-up asks the agent to
 * reformat its last answer to the strict output schema. The session already
 * contains the Phase 1 work, so the report text is not re-sent.
 */

export function buildWorkPrompt(options: { readonly prompt: string }): string {
  return [
    "# TrailStep working-agent task",
    "",
    "Do the task described below.",
    "",
    "When you are done, report what you did as your final answer in natural prose or markdown:",
    "what you changed or found, the key facts a formatter would need (status intent,",
    "summary, files changed, results), and any question you need answered if blocked.",
    "",
    "## Original prompt",
    "",
    options.prompt,
    "",
  ].join("\n");
}

export function buildFormatPrompt(options: {
  readonly outputSchema: Record<string, unknown>;
  readonly validationErrors?: readonly string[];
}): string {
  const lines = [
    "# TrailStep format follow-up",
    "",
    "Reformat your last answer in THIS session to exactly one JSON object as your entire final answer, and nothing else.",
    "Do not redo the work. Do not include prose, markdown fences, or multiple JSON values - only the JSON object itself.",
    "",
    "The JSON object must match this output schema:",
    "",
    "```json",
    JSON.stringify(options.outputSchema, null, 2),
    "```",
  ];
  if (options.validationErrors !== undefined && options.validationErrors.length > 0) {
    lines.push(
      "",
      "Your previous reformatted answer failed validation with these errors:",
      "",
      ...options.validationErrors.map((error) => `- ${error}`),
      "",
      "Fix only the formatting to satisfy the schema.",
    );
  }
  lines.push("");
  return lines.join("\n");
}
