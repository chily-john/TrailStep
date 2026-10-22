import { readFile } from "node:fs/promises";

import type { TrailStepCliPrompts } from "../command-framework/command.types.js";
import { promptSelect } from "../prompts/prompt-helpers.js";
import type { McpRegistrationScope } from "./mcp-registration.types.js";

export const DEFAULT_GITIGNORE_ENTRY = ".mcp.json";

const SCOPE_CHOICES = [
  "Project (committed)",
  "Local (gitignored, stays on this machine)",
  "Global (user-level config)",
] as const;

/** Asks a yes/no question, defaulting to the yes/no prompt fallback. */
export async function promptConfirmDefaultYes(
  label: string,
  prompts: TrailStepCliPrompts,
): Promise<boolean> {
  if (prompts.confirm !== undefined) {
    return prompts.confirm(label);
  }
  return (
    (await promptSelect(label, ["yes", "no"] as const, prompts, "A yes/no answer is required.")) ===
    "yes"
  );
}

/**
 * Asks where the MCP registration should live once the user accepted the
 * registration offer. The choice maps onto add-mcp argv flags: local appends
 * `--gitignore`, global appends `--global`, and project appends nothing.
 */
export async function promptRegistrationScope(
  prompts: TrailStepCliPrompts,
): Promise<McpRegistrationScope> {
  const selected = await promptSelect(
    "Where should the TrailStep MCP server registration live?",
    SCOPE_CHOICES,
    prompts,
    "A registration scope answer is required.",
  );
  return scopeFromChoice(selected);
}

export function scopeFromChoice(choice: string): McpRegistrationScope {
  if (choice.startsWith("Local")) {
    return "local";
  }
  if (choice.startsWith("Global")) {
    return "global";
  }
  return "project";
}

/**
 * Shows the entry that add-mcp's `--gitignore` flag appends to the project's
 * .gitignore, noting when the entry is already listed.
 */
export async function gitignoreAppendPreview(
  gitignorePath: string,
  entry: string,
): Promise<string> {
  try {
    const content = await readFile(gitignorePath, "utf8");
    const alreadyListed = content.split(/\r?\n/).some((line) => line.trim() === entry);
    return alreadyListed ? `${entry} (already listed)` : entry;
  } catch {
    return entry;
  }
}
