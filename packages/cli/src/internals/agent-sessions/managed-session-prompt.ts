export function buildManagedSessionPrompt(): string {
  return [
    "# TrailStep managed agent session",
    "",
    "This standalone coding-agent session was opened by TrailStep.",
    "",
    "If the user asks you to hand off, turn over, or preserve this session, use a session export tool when one is available.",
    "If no export tool is available, create a dense session description for the next agent.",
    "",
    "A dense session description should include decisions made, constraints, rejected options, assumptions, files touched/inspected, commands run, APIs/package names, examples, user preferences, open questions, and implementation context useful to another agent.",
    "",
  ].join("\n");
}
