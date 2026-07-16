import { CliUsageError } from "../../command.types.js";
import type { ParsedRunOptions } from "./run-command.types.js";

export function parseRunArgs(rest: readonly string[]): ParsedRunOptions | undefined {
  let inlineInput: string | undefined;
  let inputFile: string | undefined;
  let resume = false;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--resume") {
      resume = true;
      continue;
    }

    const value = rest[index + 1];
    if (option !== "--input" && option !== "--input-file") {
      throw new CliUsageError(`Unknown option: ${option ?? ""}`);
    }
    if (!value) {
      throw new CliUsageError(`Missing value for ${option}.`);
    }
    if (option === "--input") {
      inlineInput = value;
    } else {
      inputFile = value;
    }
    index += 1;
  }
  if (inlineInput !== undefined && inputFile !== undefined) {
    throw new CliUsageError("Choose either --input or --input-file, not both.");
  }
  if (resume && (inlineInput !== undefined || inputFile !== undefined)) {
    throw new CliUsageError("Choose either --resume or input, not both.");
  }
  if (resume) {
    return { resume: true };
  }
  if (inlineInput !== undefined) {
    return { input: { kind: "inline", json: inlineInput } };
  }
  if (inputFile !== undefined) {
    return { input: { kind: "file", path: inputFile } };
  }
  return undefined;
}
