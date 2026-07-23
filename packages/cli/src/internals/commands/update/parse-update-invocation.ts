import { CliUsageError } from "../../command.types.js";
import type { UpdateCommandArgs, UpdateScope } from "./update-command.types.js";

export function parseUpdateInvocation(argv: readonly string[]): UpdateCommandArgs {
  if (argv[0] !== "update") {
    throw new CliUsageError("Expected update command.");
  }

  let scope: UpdateScope = { kind: "self" };
  let hasExplicitScope = false;
  let force = false;
  let assumeYes = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--assume-yes") {
      assumeYes = true;
      continue;
    }

    if (arg === "--all") {
      scope = setScope(scope, hasExplicitScope, { kind: "all" });
      hasExplicitScope = true;
      continue;
    }

    if (arg === "--workflows") {
      scope = setScope(scope, hasExplicitScope, { kind: "workflows" });
      hasExplicitScope = true;
      continue;
    }

    if (arg.startsWith("--workflow=")) {
      const name = arg.slice("--workflow=".length);
      if (!name) {
        throw new CliUsageError("Expected workflow name after --workflow.");
      }
      scope = setScope(scope, hasExplicitScope, { kind: "workflow", name });
      hasExplicitScope = true;
      continue;
    }

    if (arg === "--workflow") {
      const name = argv[index + 1];
      if (!name || name.startsWith("--")) {
        throw new CliUsageError("Expected workflow name after --workflow.");
      }
      scope = setScope(scope, hasExplicitScope, { kind: "workflow", name });
      hasExplicitScope = true;
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }

    throw new CliUsageError(`Unexpected argument: ${arg}`);
  }

  return { scope, force, assumeYes };
}

function setScope(
  _current: UpdateScope,
  hasExplicitScope: boolean,
  next: UpdateScope,
): UpdateScope {
  if (hasExplicitScope) {
    throw new CliUsageError("Choose only one update scope: --all, --workflows, or --workflow.");
  }

  return next;
}
