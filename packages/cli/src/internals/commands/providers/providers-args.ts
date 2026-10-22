import type { CliCommandContext } from "../../command-framework/command.types.js";
import { CliUsageError } from "../../command-framework/command.types.js";
import { parseCommandFlags } from "../../command-framework/flags.js";
import type { WorkflowRegistryScope } from "../../workflow-registry/workflow-registry.js";

import type { ProviderCommandArgs } from "./providers-command.types.js";

export function parseProvidersCommandArgs(argv: readonly string[]): ProviderCommandArgs {
  if (argv[0] !== "providers") {
    throw new CliUsageError("Expected providers command.");
  }

  const action = argv[1];
  if (action === "inspect") {
    const manifestPath = argv[2];
    assertRequiredArg(manifestPath, "trailstep providers inspect requires <path>.");
    assertNoExtraArgs(argv.slice(3), "trailstep providers inspect");
    return { action: "inspect", path: manifestPath };
  }
  if (action === "add") {
    const manifestPath = argv[2];
    assertRequiredArg(manifestPath, "trailstep providers add requires <path>.");
    const flags = parseScopeFlags(argv.slice(3));
    return { action: "add", path: manifestPath, scope: parseOptionalScope(flags.scope) };
  }
  if (action === "list") {
    const flags = parseScopeFlags(argv.slice(2));
    return { action: "list", scope: parseOptionalScope(flags.scope) };
  }
  if (action === "show") {
    return parseShowArgs(argv.slice(2));
  }
  if (action === "test") {
    const provider = argv[2];
    assertRequiredArg(provider, "trailstep providers test requires <provider>.");
    const flags = parseScopeFlags(argv.slice(3));
    return { action: "test", provider, scope: parseOptionalScope(flags.scope) };
  }
  if (action === "migrate") {
    const flags = parseScopeFlags(argv.slice(2));
    return { action: "migrate", scope: parseOptionalScope(flags.scope) };
  }
  if (action === "remove") {
    const provider = argv[2];
    assertRequiredArg(provider, "trailstep providers remove requires <provider>.");
    const flags = parseScopeFlags(argv.slice(3));
    return { action: "remove", provider, scope: parseOptionalScope(flags.scope) };
  }
  if (action === undefined || action === "--scope" || !isProviderSubcommand(action)) {
    return parseShowArgs(argv.slice(1));
  }

  throw new CliUsageError(
    "trailstep providers requires inspect, add, list, show, test, migrate, remove, or no subcommand for provider details.",
  );
}

function parseShowArgs(
  argv: readonly string[],
): Extract<ProviderCommandArgs, { readonly action: "show" }> {
  const provider = argv[0]?.startsWith("--") ? undefined : argv[0];
  const flags = parseScopeFlags(provider === undefined ? argv : argv.slice(1));
  return {
    action: "show",
    ...(provider === undefined ? {} : { provider }),
    scope: parseOptionalScope(flags.scope),
  };
}

function isProviderSubcommand(value: string): boolean {
  return ["inspect", "add", "list", "show", "test", "migrate", "remove"].includes(value);
}

export async function resolveScope(
  scope: WorkflowRegistryScope | undefined,
  context: CliCommandContext,
): Promise<WorkflowRegistryScope> {
  if (scope !== undefined) {
    return scope;
  }
  if (context.prompts === undefined) {
    throw new CliUsageError("trailstep providers requires --scope <local|project|global>.");
  }
  const selection = await context.prompts.select("Scope", ["local", "project", "global"]);
  return parseScope(selection);
}

function parseScopeFlags(argv: readonly string[]): Record<string, string | undefined> {
  return parseCommandFlags(argv, {
    commandLabel: "trailstep providers",
    valueFlags: ["--scope"],
    allowEmptyValue: true,
  });
}

function parseOptionalScope(value: string | undefined): WorkflowRegistryScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseScope(value);
}

function parseScope(value: string): WorkflowRegistryScope {
  if (value === "local" || value === "project" || value === "global") {
    return value;
  }
  throw new CliUsageError(
    "trailstep providers requires --scope local, --scope project, or --scope global.",
  );
}

function assertRequiredArg(value: string | undefined, message: string): asserts value is string {
  if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
    throw new CliUsageError(message);
  }
}

function assertNoExtraArgs(argv: readonly string[], command: string): void {
  if (argv.length > 0) {
    throw new CliUsageError(`Unknown option for ${command}: ${argv[0] ?? ""}`);
  }
}
