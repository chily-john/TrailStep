import { CliUsageError } from "../../command.types.js";
import type { ContinueCommandArgs } from "./continue-command.types.js";

export function parseContinueInvocation(argv: readonly string[]): ContinueCommandArgs {
  if (argv[0] !== "continue") {
    throw new CliUsageError("Expected continue command.");
  }

  const [, ...args] = argv;
  if (args.length === 0) {
    return { mode: "select" };
  }

  const modes = ["--interactive-file", "--session-file", "--json-file", "--json"].filter((flag) =>
    args.includes(flag),
  );
  if (modes.length !== 1) {
    throw new CliUsageError(
      "Expected exactly one continue mode: --interactive-file <path>, --session-file <path>, --json-file <path>, or --json '<json>'.",
    );
  }

  if (args.length !== 2) {
    throw new CliUsageError(`${modes[0]} requires exactly one value.`);
  }

  const [flag, value] = args;
  if (flag !== modes[0] || !value) {
    throw new CliUsageError(`${modes[0]} requires exactly one value.`);
  }

  if (flag === "--interactive-file") {
    return { mode: "interactive-file", path: value };
  }

  if (flag === "--session-file") {
    return { mode: "session-file", path: value };
  }

  if (flag === "--json-file") {
    return { mode: "json-file", path: value };
  }

  return { mode: "json", json: value };
}
