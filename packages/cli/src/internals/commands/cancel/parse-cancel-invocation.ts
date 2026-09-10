import { CliUsageError } from "../../command.types.js";
import type { CancelCommandArgs } from "./cancel-command.types.js";

export function parseCancelInvocation(argv: readonly string[]): CancelCommandArgs {
  if (argv[0] !== "cancel") {
    throw new CliUsageError("Expected cancel command.");
  }

  const [, ...args] = argv;
  let runNameOrRunDir: string | undefined;
  let reason: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reason") {
      const value = args[index + 1];
      if (!value) {
        throw new CliUsageError("Expected a value after --reason.");
      }
      reason = value;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--")) {
      throw new CliUsageError(
        "Expected: cancel <runNameOrRunDir> [--reason '<text>'] or cancel [--reason '<text>'].",
      );
    }

    if (runNameOrRunDir !== undefined) {
      throw new CliUsageError(
        "Expected: cancel <runNameOrRunDir> [--reason '<text>'] or cancel [--reason '<text>'].",
      );
    }
    runNameOrRunDir = arg;
  }

  return {
    ...(runNameOrRunDir === undefined ? {} : { runNameOrRunDir }),
    ...(reason === undefined ? {} : { reason }),
  };
}
