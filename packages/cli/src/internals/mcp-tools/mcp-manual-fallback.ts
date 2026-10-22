import type { TrailStepCliIo } from "../command-framework/command.types.js";
import type { McpRegistrationSpawnResult, McpServerLaunchSpec } from "./mcp-registration.types.js";
import { quoteForShell } from "./mcp-shell-quoting.js";
import type { PiMcpWriteResult } from "./pi-mcp-registration.js";

/**
 * Reports the outcome of pi's direct config write. A failed write is never
 * fatal: the registration is the valuable part and the exposure profile is a
 * refinement, so the run keeps going and the manual command is printed.
 */
export function reportPiRegistration(
  io: TrailStepCliIo,
  result: PiMcpWriteResult,
  piManualCommand: string,
): void {
  if (result.status === "registered") {
    io.writeLine(
      `Registered the TrailStep MCP server (${result.serverName}) with pi in ${result.configPath}.`,
    );
    return;
  }
  if (result.status === "existing") {
    io.writeError(
      `Warning: ${result.reason ?? "a server entry is already registered"} in ${result.configPath}; leaving it unchanged.`,
    );
    return;
  }
  io.writeError(
    `Warning: could not update pi's MCP configuration in ${result.configPath}: ${result.reason ?? "unknown error"}`,
  );
  io.writeLine("Register the TrailStep MCP server with pi manually by running this command:");
  io.writeLine(piManualCommand);
}

/**
 * Prints the manual fallback for every failed automatic registration: the
 * exact command to run, the absolute paths that must not be rewritten, and the
 * command that would have been registered.
 */
export function writeManualFallbackInstructions(
  io: TrailStepCliIo,
  options: {
    readonly serverCommand: McpServerLaunchSpec;
    readonly manualCommand: string;
    readonly reason: string;
    readonly piManualCommand?: string;
    readonly addMcpManualCommand?: string;
  },
): void {
  io.writeLine(`Automatic MCP registration failed: ${options.reason}`);
  io.writeLine(
    "Register the TrailStep MCP server manually by running this exact command in a terminal:",
  );
  io.writeLine(options.manualCommand);
  if (options.piManualCommand !== undefined && options.piManualCommand !== options.manualCommand) {
    io.writeLine(
      "Register the TrailStep MCP server with pi manually by running this exact command in a terminal:",
    );
    io.writeLine(options.piManualCommand);
  }
  if (
    options.addMcpManualCommand !== undefined &&
    options.addMcpManualCommand !== options.manualCommand
  ) {
    io.writeLine(
      "Register the TrailStep MCP server with the other detected agents by running this exact command in a terminal:",
    );
    io.writeLine(options.addMcpManualCommand);
  }
  io.writeLine(
    "Keep the printed paths exactly as written; they are absolute and must not be rewritten as relative paths.",
  );
  io.writeLine("The server command that will be registered is:");
  io.writeLine(formatServerCommandForDisplay(options.serverCommand));
}

export function formatServerCommandForDisplay(serverCommand: McpServerLaunchSpec): string {
  return [quoteForShell(serverCommand.command), ...serverCommand.args.map(quoteForShell)].join(" ");
}

export function describeSpawnFailure(error: unknown, exitCode?: number, output?: string): string {
  const message = error instanceof Error ? error.message : "";
  const combined = `${message}\n${output ?? ""}`;
  if (combined.includes("ERR_TTY_INIT_FAILED")) {
    return "add-mcp needs an interactive terminal (ERR_TTY_INIT_FAILED) and none is available here.";
  }
  if (error !== undefined) {
    return `could not spawn add-mcp (${message || "unknown error"}).`;
  }
  const firstLine = (output ?? "").split(/\r?\n/).find((line) => line.trim().length > 0);
  return `add-mcp exited with code ${exitCode}${firstLine === undefined ? "" : `: ${firstLine.trim()}`}.`;
}

export function ttyInitFailed(result: McpRegistrationSpawnResult): boolean {
  return `${result.stderr ?? ""}\n${result.stdout ?? ""}`.includes("ERR_TTY_INIT_FAILED");
}
