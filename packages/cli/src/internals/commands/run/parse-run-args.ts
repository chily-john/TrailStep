import { CliUsageError } from "../../command.types.js";
import type { InputSource } from "./run-command.types.js";

export function parseRunArgs(rest: readonly string[]): InputSource | undefined {
  let inlineInput: string | undefined;
  let inputFile: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
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
    return { kind: "inline", json: inlineInput };
  }
  if (inputFile !== undefined) {
    return { kind: "file", path: inputFile };
  }
  return undefined;
}
