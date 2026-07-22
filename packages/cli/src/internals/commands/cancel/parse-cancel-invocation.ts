import { CliUsageError } from "../../command.types.js";
import type { CancelCommandArgs } from "./cancel-command.types.js";

export function parseCancelInvocation(argv: readonly string[]): CancelCommandArgs {
  if (argv[0] !== "cancel") {
    throw new CliUsageError("Expected cancel command.");
  }

  const [, ...args] = argv;
  if (args.length === 0) {
    return {};
  }

  const [flag, value] = args;
  if (args.length === 2 && flag === "--reason" && value) {
    return { reason: value };
  }

  throw new CliUsageError("Expected: cancel [--reason '<text>'].");
}
