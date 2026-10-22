import { writeFile } from "node:fs/promises";

import {
  extractEnvelopeOutput,
  extractEnvelopeText,
} from "../../../../cli-provider-runtime/envelopes/envelope.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import { errorMessage, isRecord } from "../../../../json/guards.js";
import type { TrailStepProviderOutputManifest } from "../../../../providers/provider-manifest.js";

export async function writeCapturedStdoutOutput(options: {
  readonly provider: string;
  readonly stepId: string;
  readonly outputFile: string;
  readonly captureMode?: "json" | "raw-text";
  readonly stdout?: string;
  readonly output?: TrailStepProviderOutputManifest;
  readonly extractOutputHook?: unknown;
}): Promise<void> {
  if (options.stdout === undefined) {
    return;
  }

  if (
    options.output?.style === "stdout-json-envelope" ||
    options.output?.style === "stdout-jsonl-transcript"
  ) {
    await writeEnvelopeOutput({ ...options, stdout: options.stdout });
    return;
  }

  if (isRecord(options.extractOutputHook)) {
    const extracted = extractJsonObject(options.stdout);
    if (extracted === undefined) {
      throw new TrailStepFailureError({
        code: "agent_provider_output_invalid",
        message: `Working agent step ${options.stepId} provider '${options.provider}' could not extract JSON output from stdout using declared hook metadata.`,
        details: { provider: options.provider },
      });
    }

    await writeFile(options.outputFile, `${JSON.stringify(extracted)}\n`, "utf8");
  }
}

async function writeEnvelopeOutput(options: {
  readonly provider: string;
  readonly stepId: string;
  readonly outputFile: string;
  readonly captureMode?: "json" | "raw-text";
  readonly stdout: string;
  readonly output?: TrailStepProviderOutputManifest;
}): Promise<void> {
  try {
    const resultField = options.output?.parsing?.resultField ?? "result";
    if (options.captureMode === "raw-text") {
      const text = extractEnvelopeText(options.stdout, { resultField });
      await writeFile(options.outputFile, text, "utf8");
      return;
    }

    const extracted = extractEnvelopeOutput(options.stdout, { resultField });
    await writeFile(options.outputFile, `${JSON.stringify(extracted)}\n`, "utf8");
  } catch (error) {
    throw new TrailStepFailureError({
      code: "agent_provider_output_invalid",
      message: `Working agent step ${options.stepId} provider '${options.provider}' could not parse stdout envelope output.`,
      details: {
        provider: options.provider,
        cause: errorMessage(error),
      },
    });
  }
}

function extractJsonObject(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}
