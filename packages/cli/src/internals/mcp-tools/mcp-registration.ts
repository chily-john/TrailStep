import { join } from "node:path";
import { appendGitignoreEntry, PI_MCP_GITIGNORE_ENTRY } from "./gitignore-append.js";
import {
  buildAddMcpSpawnRequest,
  defaultAddMcpEntryPath,
  defaultMcpRegistrationRunner,
  formatAddMcpManualCommand,
} from "./mcp-add-mcp-command.js";
import { detectMcpAgentTargets } from "./mcp-agent-targets.js";
import {
  describeSpawnFailure,
  reportPiRegistration,
  ttyInitFailed,
  writeManualFallbackInstructions,
} from "./mcp-manual-fallback.js";
import type {
  McpRegistrationOutcome,
  McpRegistrationScope,
  McpRegistrationSpawnResult,
  McpServerLaunchSpec,
  OfferMcpRegistrationOptions,
} from "./mcp-registration.types.js";
import {
  DEFAULT_GITIGNORE_ENTRY,
  gitignoreAppendPreview,
  promptConfirmDefaultYes,
  promptRegistrationScope,
} from "./mcp-registration-prompts.js";
import {
  absoluteProjectDir,
  buildTrailStepMcpServerCommand,
  mcpServerNameForScope,
} from "./mcp-server-command.js";
import type { PiMcpWriteResult } from "./pi-mcp-registration.js";
import {
  formatPiManualCommand,
  type PiMcpScope,
  type PiMcpWriteStatus,
  resolvePiMcpConfigPath,
  writePiMcpServerEntry,
} from "./pi-mcp-registration.js";

/** Agent target that is registered by a direct config write instead of add-mcp. */
const PI_AGENT_TARGET = "pi";

const MCP_REGISTRATION_PROMPT_LABEL =
  "Register the TrailStep MCP server (trst_* workflow tools) with your coding agent?";

/**
 * Announces and performs pi's direct config write for the resolved scope, then
 * reports the outcome. Shared by the interactive and headless offer paths.
 */
async function runPiDirectWrite(
  options: OfferMcpRegistrationOptions,
  scope: McpRegistrationScope,
  serverCommand: McpServerLaunchSpec,
): Promise<PiMcpWriteResult> {
  const piServerName = mcpServerNameForScope(scope);
  const piConfigPath = resolvePiMcpConfigPath({
    projectDir: options.projectDir,
    scope: scope as PiMcpScope,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  options.io.writeLine("Registering the TrailStep MCP server directly with pi:");
  options.io.writeLine(`  ${piConfigPath}`);
  const piResult = await writePiMcpServerEntry({
    projectDir: options.projectDir,
    scope: scope as PiMcpScope,
    serverName: piServerName,
    serverCommand,
    ...(options.cliEntryPath === undefined ? {} : { cliEntryPath: options.cliEntryPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  reportPiRegistration(
    options.io,
    piResult,
    formatPiManualCommand({ serverCommand, serverName: piServerName }),
  );
  return piResult;
}

/**
 * Auto-offers add-mcp registration of the TrailStep MCP server. Interactive by
 * default (default-yes); headless runs print the exact manual command instead
 * of prompting, and any spawn failure (including ERR_TTY_INIT_FAILED) prints
 * clear manual fallback instructions with the absolute paths preserved.
 */
export async function offerMcpRegistration(
  options: OfferMcpRegistrationOptions,
): Promise<McpRegistrationOutcome> {
  const agentTargets = await detectMcpAgentTargets({
    projectDir: options.projectDir,
    scope: options.scope ?? "project",
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  // pi is registered by writing its own config file directly because
  // `exposure` / `toolExposure` are pi-only concepts that add-mcp cannot
  // express. pi is therefore excluded from the add-mcp `-a` list, otherwise
  // add-mcp would write a second, competing entry into the user-level file.
  const piDetected = agentTargets.includes(PI_AGENT_TARGET);
  const addMcpAgentTargets = agentTargets.filter((agent) => agent !== PI_AGENT_TARGET);
  // add-mcp is skipped only when pi is the sole detected target: otherwise it
  // still runs (with the remaining targets) exactly as before.
  const useAddMcpPath = !(piDetected && addMcpAgentTargets.length === 0);
  const buildForScope = (scope: McpRegistrationScope) => {
    const serverCommand = buildTrailStepMcpServerCommand({
      projectDir: options.projectDir,
      scope,
      ...(options.nodeBinaryPath === undefined ? {} : { nodeBinaryPath: options.nodeBinaryPath }),
      ...(options.cliEntryPath === undefined ? {} : { cliEntryPath: options.cliEntryPath }),
    });
    const addMcpManualCommand = formatAddMcpManualCommand({
      serverCommand,
      agentTargets: addMcpAgentTargets,
      scope,
    });
    const piManualCommand = formatPiManualCommand({
      serverCommand,
      serverName: mcpServerNameForScope(scope),
    });
    return {
      serverCommand,
      addMcpManualCommand,
      piManualCommand,
      // pi's native command replaces add-mcp's whenever pi is a target.
      manualCommand: piDetected ? piManualCommand : addMcpManualCommand,
    };
  };

  if (options.assumeYes === true || options.prompts === undefined) {
    const headlessScope = options.scope ?? "project";
    const { serverCommand, addMcpManualCommand, piManualCommand, manualCommand } =
      buildForScope(headlessScope);
    let piWriteStatus: PiMcpWriteStatus | undefined;
    if (piDetected) {
      // Headless runs perform pi's direct write instead of only printing the
      // manual command; the add-mcp spawn stays TTY-gated and headless callers
      // never reach it.
      piWriteStatus = (await runPiDirectWrite(options, headlessScope, serverCommand)).status;
    }
    options.io.writeLine(
      "Register the TrailStep MCP server manually by running this command in a terminal:",
    );
    options.io.writeLine(manualCommand);
    if (piDetected && addMcpAgentTargets.length > 0) {
      options.io.writeLine(
        "Register the TrailStep MCP server with the other detected agents by running this command in a terminal:",
      );
      options.io.writeLine(addMcpManualCommand);
    }
    const piSucceeded =
      piWriteStatus === undefined || piWriteStatus === "registered" || piWriteStatus === "updated";
    return {
      status: piDetected ? (piSucceeded ? "registered" : "failed") : "manual",
      manualCommand,
      serverCommand,
      agentTargets,
      scope: headlessScope,
      ...(piDetected ? { piManualCommand, piWriteStatus } : {}),
      ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
    };
  }

  const offeredScope = options.scope ?? "project";
  const offered = buildForScope(offeredScope);

  const promptLabel =
    agentTargets.length > 0
      ? `${MCP_REGISTRATION_PROMPT_LABEL} (detected: ${agentTargets.join(", ")})`
      : MCP_REGISTRATION_PROMPT_LABEL;
  const accepted = await promptConfirmDefaultYes(promptLabel, options.prompts);
  if (!accepted) {
    options.io.writeLine("Skipped TrailStep MCP server registration.");
    options.io.writeLine("You can register it later by running this command in a terminal:");
    options.io.writeLine(offered.manualCommand);
    if (piDetected && addMcpAgentTargets.length > 0) {
      options.io.writeLine(offered.addMcpManualCommand);
    }
    return {
      status: "declined",
      manualCommand: offered.manualCommand,
      serverCommand: offered.serverCommand,
      agentTargets,
      scope: offeredScope,
      ...(piDetected ? { piManualCommand: offered.piManualCommand } : {}),
      ...(addMcpAgentTargets.length > 0
        ? { addMcpManualCommand: offered.addMcpManualCommand }
        : {}),
    };
  }

  const scope = options.scope ?? (await promptRegistrationScope(options.prompts));
  // Rebuild for the resolved scope so every later message and the outcome
  // carry the scope-accurate server name, `--project` pinning, and scope flags.
  const { serverCommand, addMcpManualCommand, piManualCommand, manualCommand } =
    scope === offeredScope ? offered : buildForScope(scope);
  if (scope === "local") {
    const gitignorePath = absoluteProjectDir(
      options.gitignorePath ?? join(options.projectDir, ".gitignore"),
    );
    const pendingEntries: string[] = [];
    if (useAddMcpPath) {
      // add-mcp owns the generic `.mcp.json` gitignore append (via `--gitignore`).
      pendingEntries.push(options.gitignoreEntry ?? DEFAULT_GITIGNORE_ENTRY);
    }
    if (piDetected) {
      // pi writes `<projectDir>/.pi/mcp.json` directly, so TrailStep appends
      // its own gitignore entry for the local (gitignored) registration.
      pendingEntries.push(PI_MCP_GITIGNORE_ENTRY);
    }
    if (pendingEntries.length > 0) {
      for (const entry of pendingEntries) {
        const preview = await gitignoreAppendPreview(gitignorePath, entry);
        options.io.writeLine(
          `Local registration appends the --gitignore entry to ${gitignorePath}:`,
        );
        options.io.writeLine(`  ${preview}`);
      }
      const localConfirmed = await promptConfirmDefaultYes(
        "Proceed with local (gitignored) registration?",
        options.prompts,
      );
      if (!localConfirmed) {
        options.io.writeLine("Skipped TrailStep MCP server registration.");
        options.io.writeLine("You can register it later by running this command in a terminal:");
        options.io.writeLine(manualCommand);
        return {
          status: "declined",
          manualCommand,
          serverCommand,
          agentTargets,
          scope,
          ...(piDetected ? { piManualCommand } : {}),
          ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
        };
      }
      if (piDetected) {
        await appendGitignoreEntry(gitignorePath, PI_MCP_GITIGNORE_ENTRY);
      }
    }
  } else if (scope === "global") {
    options.io.writeLine(
      "Global registration writes a user-level config; the server omits --project and follows the agent client's current project (its layered tools plus global ~/.trailstep tools).",
    );
  }

  // pi's registration is a direct config write, so it happens for every scope
  // and never depends on add-mcp being installed.
  let piWriteStatus: PiMcpWriteStatus | undefined;
  if (piDetected) {
    piWriteStatus = (await runPiDirectWrite(options, scope, serverCommand)).status;
  }

  if (piDetected && addMcpAgentTargets.length === 0) {
    // pi is the only detected target: add-mcp is not spawned at all.
    const piSucceeded = piWriteStatus === "registered" || piWriteStatus === "updated";
    return {
      status: piSucceeded ? "registered" : "failed",
      manualCommand,
      serverCommand,
      agentTargets,
      scope,
      ...(piDetected ? { piManualCommand, piWriteStatus } : {}),
    };
  }

  if (
    piWriteStatus !== undefined &&
    piWriteStatus !== "registered" &&
    piWriteStatus !== "updated"
  ) {
    // The pi direct write refused (existing entry) or failed; the offer never
    // reports `registered` in those cases, and the manual command is printed.
    return {
      status: "failed",
      manualCommand,
      serverCommand,
      agentTargets,
      scope,
      ...(piDetected ? { piManualCommand, piWriteStatus } : {}),
      ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
    };
  }

  const resolveAddMcpEntry = options.resolveAddMcpEntry ?? defaultAddMcpEntryPath;
  const addMcpEntryPath =
    options.addMcpEntryPath === undefined ? resolveAddMcpEntry() : options.addMcpEntryPath;
  if (addMcpEntryPath === undefined || addMcpEntryPath === null) {
    options.io.writeLine(
      "add-mcp could not be located for automatic registration. Register the TrailStep MCP server manually by running this command in a terminal:",
    );
    options.io.writeLine(manualCommand);
    if (piDetected && addMcpAgentTargets.length > 0) {
      options.io.writeLine(addMcpManualCommand);
    }
    return {
      status: "manual",
      manualCommand,
      serverCommand,
      agentTargets,
      scope,
      ...(piDetected ? { piManualCommand } : {}),
      ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
    };
  }

  const request = buildAddMcpSpawnRequest({
    serverCommand,
    projectDir: options.projectDir,
    addMcpEntryPath,
    agentTargets: addMcpAgentTargets,
    scope,
    ...(options.nodeBinaryPath === undefined ? {} : { nodeBinaryPath: options.nodeBinaryPath }),
  });

  const runner = options.runner ?? defaultMcpRegistrationRunner;
  let result: McpRegistrationSpawnResult;
  try {
    result = await runner(request);
  } catch (error) {
    writeManualFallbackInstructions(options.io, {
      serverCommand,
      manualCommand,
      reason: describeSpawnFailure(error),
      ...(piDetected ? { piManualCommand } : {}),
      ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
    });
    return {
      status: "failed",
      manualCommand,
      serverCommand,
      agentTargets,
      scope,
      ...(piDetected ? { piManualCommand } : {}),
      ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
    };
  }

  if (result.exitCode !== 0 || ttyInitFailed(result)) {
    writeManualFallbackInstructions(options.io, {
      serverCommand,
      manualCommand,
      reason: describeSpawnFailure(
        undefined,
        result.exitCode,
        result.stderr ?? result.stdout ?? "",
      ),
      ...(piDetected ? { piManualCommand } : {}),
      ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
    });
    return {
      status: "failed",
      manualCommand,
      serverCommand,
      agentTargets,
      scope,
      ...(piDetected ? { piManualCommand } : {}),
      ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
    };
  }

  options.io.writeLine(
    `add-mcp registered the TrailStep MCP server (${mcpServerNameForScope(scope)}) with your coding agent.`,
  );
  return {
    status: "registered",
    manualCommand,
    serverCommand,
    agentTargets,
    scope,
    ...(piDetected ? { piManualCommand, piWriteStatus } : {}),
    ...(addMcpAgentTargets.length > 0 ? { addMcpManualCommand } : {}),
  };
}

export {
  buildAddMcpSpawnRequest,
  defaultAddMcpEntryPath,
  formatAddMcpManualCommand,
} from "./mcp-add-mcp-command.js";
export { detectMcpAgentTargets } from "./mcp-agent-targets.js";
export type {
  BuildTrailStepMcpServerCommandOptions,
  McpRegistrationOutcome,
  McpRegistrationRunner,
  McpRegistrationScope,
  McpRegistrationSpawnRequest,
  McpRegistrationSpawnResult,
  McpServerLaunchSpec,
  OfferMcpRegistrationOptions,
} from "./mcp-registration.types.js";
export {
  absoluteProjectDir,
  buildTrailStepMcpServerCommand,
  mcpServerNameForScope,
  TRAILSTEP_MCP_SERVER_GLOBAL_NAME,
  TRAILSTEP_MCP_SERVER_NAME,
} from "./mcp-server-command.js";
