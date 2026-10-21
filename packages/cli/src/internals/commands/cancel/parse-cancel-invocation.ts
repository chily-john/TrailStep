import { CliUsageError } from "../../command.types.js";
import type { CancelCommandArgs } from "./cancel-command.types.js";

const CANCEL_USAGE =
  "Expected: cancel <runNameOrRunDir> [--reason '<text>'], cancel <runNameOrRunDir> --clear, or cancel [--reason '<text>'].";

export function parseCancelInvocation(argv: readonly string[]): CancelCommandArgs {
  if (argv[0] !== "cancel") {
    throw new CliUsageError("Expected cancel command.");
  }

  const [, ...args] = argv;
  let runNameOrRunDir: string | undefined;
  let reason: string | undefined;
  let clear = false;

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

    if (arg === "--clear") {
      clear = true;
      continue;
    }

    if (arg?.startsWith("--")) {
      throw new CliUsageError(CANCEL_USAGE);
    }

    if (runNameOrRunDir !== undefined) {
      throw new CliUsageError(CANCEL_USAGE);
    }
    runNameOrRunDir = arg;
  }

  if (clear) {
    if (reason !== undefined) {
      throw new CliUsageError(
        "--clear removes a pending cancellation and cannot be combined with --reason.",
      );
    }
    if (runNameOrRunDir === undefined) {
      throw new CliUsageError(
        "cancel --clear requires a run: Expected: cancel <runNameOrRunDir> --clear.",
      );
    }
  }

  return {
    ...(runNameOrRunDir === undefined ? {} : { runNameOrRunDir }),
    ...(reason === undefined ? {} : { reason }),
    ...(clear ? { clear } : {}),
  };
}
