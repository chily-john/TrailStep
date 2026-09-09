import { CliUsageError } from "../../command.types.js";
import type { InputOverride, ParsedRunOptions } from "./run-command.types.js";

export function parseRunArgs(rest: readonly string[]): ParsedRunOptions | undefined {
  let inlineInput: string | undefined;
  let inputFile: string | undefined;
  const inputOverrides: InputOverride[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--resume") {
      throw new CliUsageError(
        "Legacy --resume is no longer supported. Use trailstep retry <workflow-ref> <runName> instead.",
      );
    }

    if (option === "--input" || option === "--input-file") {
      const value = rest[index + 1];
      if (!value) {
        throw new CliUsageError(`Missing value for ${option}.`);
      }
      if (option === "--input") {
        inlineInput = value;
      } else {
        inputFile = value;
      }
      index += 1;
      continue;
    }

    if (option === "--set") {
      const assignment = rest[index + 1];
      if (!assignment) {
        throw new CliUsageError("Missing value for --set.");
      }
      inputOverrides.push(parseSetAssignment(assignment));
      index += 1;
      continue;
    }

    if (option?.startsWith("--") && option.length > 2) {
      const value = rest[index + 1];
      if (!value) {
        throw new CliUsageError(`Missing value for ${option}.`);
      }
      const path = option.slice(2);
      inputOverrides.push({ kind: "flag", path, rawValue: value, source: option });
      index += 1;
      continue;
    }

    throw new CliUsageError(`Unknown option: ${option ?? ""}`);
  }

  if (inlineInput !== undefined && inputFile !== undefined) {
    throw new CliUsageError("Choose either --input or --input-file, not both.");
  }

  const parsed: ParsedRunOptions = {
    ...(inlineInput === undefined ? {} : { input: { kind: "inline" as const, json: inlineInput } }),
    ...(inputFile === undefined ? {} : { input: { kind: "file" as const, path: inputFile } }),
    ...(inputOverrides.length === 0 ? {} : { inputOverrides }),
  };

  return parsed.input === undefined && parsed.inputOverrides === undefined ? undefined : parsed;
}

function parseSetAssignment(assignment: string): InputOverride {
  const equalsIndex = assignment.indexOf("=");
  if (equalsIndex <= 0) {
    throw new CliUsageError("Expected --set value in path=value form.");
  }

  const path = assignment.slice(0, equalsIndex);
  const rawValue = assignment.slice(equalsIndex + 1);
  if (rawValue.length === 0) {
    throw new CliUsageError(`Missing value for --set ${path}.`);
  }

  return { kind: "set", path, rawValue, source: `--set ${path}` };
}
