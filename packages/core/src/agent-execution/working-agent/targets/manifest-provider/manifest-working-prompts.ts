import { writeFile } from "node:fs/promises";

import { buildFormatPrompt, buildWorkPrompt } from "../../prompts/build-two-phase-prompts.js";

/**
 * Two-phase prompt construction for manifest working providers.
 *
 * Phase 1 overwrites the front-loaded prompt with the work-only prompt;
 * Phase 2 writes the strict output-schema format prompt. The prompt bytes
 * are produced by the shared two-phase prompt builders, so they stay
 * byte-for-byte identical to the single-file implementation.
 */
export async function writeWorkPhasePrompt(options: {
  readonly promptFile: string;
  readonly renderedPrompt: string;
}): Promise<void> {
  await writeFile(options.promptFile, buildWorkPrompt({ prompt: options.renderedPrompt }), "utf8");
}

export async function writeFormatPhasePrompt(options: {
  readonly repairPromptFile: string;
  readonly outputSchema: Record<string, unknown>;
  readonly validationError?: string;
}): Promise<void> {
  await writeFile(
    options.repairPromptFile,
    buildFormatPrompt({
      outputSchema: options.outputSchema,
      ...(options.validationError === undefined
        ? {}
        : { validationErrors: [options.validationError] }),
    }),
    "utf8",
  );
}
