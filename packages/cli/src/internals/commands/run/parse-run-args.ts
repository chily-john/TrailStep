import { CliUsageError } from "../../command.types.js";
import type { ParsedRunOptions } from "./run-command.types.js";

export function parseRunArgs(rest: readonly string[]): ParsedRunOptions | undefined {
  let inlineInput: string | undefined;
  let inputFile: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--resume") {
      throw new CliUsageError(
        "Legacy --resume is no longer supported. Use trailstep retry <workflow-ref> <runName> instead.",
      );
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
  if (inlineInput !== undefined) {
    return { input: { kind: "inline", json: inlineInput } };
  }
  if (inputFile !== undefined) {
    return { input: { kind: "file", path: inputFile } };
  }
  return undefined;
}
