import { CliUsageError } from "./command.types.js";

/**
 * Parsed command flags keyed by the flag name without its leading dashes.
 *
 * Boolean flags are recorded as the string `"true"` so that every call site
 * keeps a single, uniform representation of "the flag was present".
 */
export type CommandFlags = Record<string, string | undefined>;

export interface CommandFlagParserOptions {
  /** Command label used in error messages, e.g. `"trailstep add"`. */
  readonly commandLabel: string;
  /** Flags that take no value, e.g. `"--force"`. */
  readonly booleanFlags?: readonly string[];
  /** Flags that take a value, e.g. `"--scope"`. */
  readonly valueFlags?: readonly string[];
  /** How a flag that is neither boolean nor value is handled. Defaults to `"error"`. */
  readonly onUnknownFlag?: "error" | "ignore";
  /** How a value flag without a value is handled. Defaults to `"error"`. */
  readonly onMissingValue?: "error" | "ignore";
  /** Whether an empty string counts as a value. Defaults to `false`. */
  readonly allowEmptyValue?: boolean;
}

/**
 * Shared `--flag` / `--flag value` parser for the CLI commands.
 *
 * The parser is deliberately shape-driven so that each command keeps parsing
 * exactly what it parsed before: the caller declares which flags exist,
 * whether they take a value, and how unknown flags or missing values are
 * reported. Unknown flags and missing values throw {@link CliUsageError} with
 * the command label of the calling command.
 */
export function parseCommandFlags(
  argv: readonly string[],
  options: CommandFlagParserOptions,
): CommandFlags {
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const allowEmptyValue = options.allowEmptyValue ?? false;
  const onUnknownFlag = options.onUnknownFlag ?? "error";
  const onMissingValue = options.onMissingValue ?? "error";
  const flags: CommandFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];

    if (option !== undefined && booleanFlags.has(option)) {
      flags[option.slice(2)] = "true";
      continue;
    }

    if (option !== undefined && valueFlags.has(option)) {
      const value = argv[index + 1];
      if (value === undefined || (!allowEmptyValue && value.length === 0)) {
        if (onMissingValue === "ignore") {
          continue;
        }
        throw new CliUsageError(`Missing value for ${option}.`);
      }

      flags[option.slice(2)] = value;
      index += 1;
      continue;
    }

    if (onUnknownFlag === "ignore") {
      continue;
    }

    throw new CliUsageError(`Unknown option for ${options.commandLabel}: ${option ?? ""}`);
  }

  return flags;
}
