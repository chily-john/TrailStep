import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * pi is the only MCP client TrailStep registers by writing its config file
 * directly: `exposure` / `toolExposure` are pi-only concepts that add-mcp
 * cannot express, so the generic add-mcp path would hand every pi user the
 * default whole-server `codemode` exposure.
 *
 * Scope mapping (pi only):
 * - `project` / `local` -> `<projectDir>/.pi/mcp.json`
 * - `global` -> `<PI_CODING_AGENT_DIR ?? ~/.pi/agent>/mcp.json`
 *
 * `local` and `project` intentionally share the project path; a separate
 * gitignored location for `local` is out of scope for this change.
 */
export type PiMcpScope = "project" | "local" | "global";

/** Whole-server exposure for the TrailStep MCP server. */
export const PI_MCP_SERVER_EXPOSURE = "codemode" as const;

/**
 * Generic run-loop tools stay `direct` so the model can call them without a
 * codemode script. The 14 large-schema per-workflow `trst_*` tools keep the
 * default `codemode` exposure so they cost nothing per turn.
 */
export const PI_MCP_DIRECT_TOOL_NAMES = [
  "trst_run_workflow",
  "trst_watch",
  "trst_answer",
  "trst_resume",
] as const;

export const PI_MCP_SERVER_DESCRIPTION =
  "TrailStep workflow runtime: run, watch, answer and resume workflows, plus per-workflow trst_* tools. The trailstep://instructions resource describes the run -> watch -> answer -> resume loop.";

export interface PiMcpLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** A single pi `mcpServers` entry. */
export interface PiMcpServerEntry {
  readonly command: string;
  readonly args: string[];
  readonly env?: Record<string, string>;
  readonly exposure: "codemode";
  readonly toolExposure: Record<string, "direct">;
  readonly description: string;
}

/** pi's `mcp.json` document: `mcpServers` plus any unknown top-level keys. */
export interface PiMcpDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Builds the pi `mcpServers` entry for the TrailStep MCP server.
 *
 * `command` / `args` come from the shared `buildTrailStepMcpServerCommand`
 * helper so the node-binary + CLI-entry + `--project` shaping stays in exactly
 * one place. `env` is only emitted when the CLI entry path is known.
 */
export function buildPiMcpServerEntry(options: {
  readonly serverCommand: PiMcpLaunchSpec;
  readonly cliEntryPath?: string;
}): PiMcpServerEntry {
  const cliEntryPath = options.cliEntryPath ?? deriveCliEntryPath(options.serverCommand);
  // Note: a pi project entry that carries a `command` replaces the
  // same-named user-level entry (only `enabled` / `exposure` / `toolExposure`
  // merge between them). The project-scope entry carries the full command, so
  // it intentionally shadows the user-level entry for that project.
  return {
    command: options.serverCommand.command,
    args: [...options.serverCommand.args],
    ...(cliEntryPath === undefined ? {} : { env: { TRAILSTEP_CLI_ENTRY: cliEntryPath } }),
    exposure: PI_MCP_SERVER_EXPOSURE,
    toolExposure: Object.fromEntries(
      PI_MCP_DIRECT_TOOL_NAMES.map((toolName) => [toolName, "direct"]),
    ) as Record<string, "direct">,
    description: PI_MCP_SERVER_DESCRIPTION,
  };
}

/**
 * Resolves the pi config file that holds the MCP server entry for a scope.
 *
 * The user-level directory is `PI_CODING_AGENT_DIR` when set, otherwise
 * `~/.pi/agent`.
 */
export function resolvePiMcpConfigPath(options: {
  readonly projectDir: string;
  readonly scope: PiMcpScope;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  if (options.scope === "global") {
    return join(resolvePiUserAgentDir(options.env), "mcp.json");
  }
  return join(absoluteDir(options.projectDir), ".pi", "mcp.json");
}

/** Resolves pi's user-level agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
export function resolvePiUserAgentDir(env?: Readonly<Record<string, string | undefined>>): string {
  const configured = env === undefined ? process.env.PI_CODING_AGENT_DIR : env.PI_CODING_AGENT_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return absoluteDir(configured);
  }
  return join(homedir(), ".pi", "agent");
}

export type PiMcpWriteStatus = "registered" | "updated" | "existing" | "failed";

export interface PiMcpWriteRequest {
  readonly projectDir: string;
  readonly scope: PiMcpScope;
  /** Server name in pi's `mcpServers` map (`trailstep` / `trailstep-global`). */
  readonly serverName: string;
  readonly serverCommand: PiMcpLaunchSpec;
  readonly cliEntryPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PiMcpWriteResult {
  readonly status: PiMcpWriteStatus;
  readonly configPath: string;
  readonly serverName: string;
  /** Human-readable explanation for `existing` and `failed` results. */
  readonly reason?: string;
}

/**
 * Merges the TrailStep MCP server entry into pi's `mcp.json` and writes it
 * atomically (temp file in the same directory, renamed over the target).
 *
 * The write never throws: every failure is reported through the result so the
 * caller can warn and keep going. Other servers and unknown top-level keys are
 * preserved, and re-running converges to the same file content.
 */
export async function writePiMcpServerEntry(request: PiMcpWriteRequest): Promise<PiMcpWriteResult> {
  const configPath = resolvePiMcpConfigPath(request);
  const entry = buildPiMcpServerEntry({
    serverCommand: request.serverCommand,
    ...(request.cliEntryPath === undefined ? {} : { cliEntryPath: request.cliEntryPath }),
  });

  const loaded = await readPiMcpDocument(configPath);
  if (!loaded.ok) {
    return {
      status: "failed",
      configPath,
      serverName: request.serverName,
      reason: loaded.reason,
    };
  }

  const document = loaded.document;
  const servers = document.mcpServers ?? {};
  const existing = servers[request.serverName];
  if (existing !== undefined) {
    const sameLaunch = isSameServerLaunch(existing, entry);
    if (!sameLaunch) {
      // Never clobber a differently-configured server entry.
      return {
        status: "existing",
        configPath,
        serverName: request.serverName,
        reason: `a differently-configured "${request.serverName}" server is already registered`,
      };
    }
    if (!piEntriesEqual(existing, entry)) {
      // Same launch with a differing exposure / toolExposure: update in place.
      document.mcpServers = { ...servers, [request.serverName]: entry };
      try {
        await writeJsonAtomically(configPath, document);
      } catch (error) {
        return {
          status: "failed",
          configPath,
          serverName: request.serverName,
          reason: `could not write ${configPath}: ${describeError(error)}`,
        };
      }
      return { status: "updated", configPath, serverName: request.serverName };
    }
  }

  document.mcpServers = { ...servers, [request.serverName]: entry };
  try {
    await writeJsonAtomically(configPath, document);
  } catch (error) {
    return {
      status: "failed",
      configPath,
      serverName: request.serverName,
      reason: `could not write ${configPath}: ${describeError(error)}`,
    };
  }
  return { status: "registered", configPath, serverName: request.serverName };
}

/**
 * Renders pi's native manual registration command:
 * `pi mcp add <name> -- <command> <args...>`.
 */
export function formatPiManualCommand(options: {
  readonly serverCommand: PiMcpLaunchSpec;
  readonly serverName: string;
}): string {
  return [
    "pi",
    "mcp",
    "add",
    options.serverName,
    "--",
    options.serverCommand.command,
    ...options.serverCommand.args,
  ]
    .map((part) => quoteForShell(part))
    .join(" ");
}

async function readPiMcpDocument(
  configPath: string,
): Promise<{ ok: true; document: PiMcpDocument } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: true, document: {} };
    }
    return { ok: false, reason: `could not read ${configPath}: ${describeError(error)}` };
  }
  if (raw.trim().length === 0) {
    return { ok: true, document: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${configPath} contains malformed JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${configPath} does not contain a JSON object` };
  }
  const document = parsed as PiMcpDocument;
  const servers = document.mcpServers;
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  ) {
    return { ok: false, reason: `${configPath} has a malformed "mcpServers" section` };
  }
  return { ok: true, document };
}

async function writeJsonAtomically(configPath: string, document: PiMcpDocument): Promise<void> {
  const directory = dirname(configPath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isSameServerLaunch(existing: unknown, entry: PiMcpServerEntry): boolean {
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return false;
  }
  const record = existing as { command?: unknown; args?: unknown; env?: unknown };
  if (typeof record.command !== "string") {
    return false;
  }
  const existingArgs = Array.isArray(record.args)
    ? record.args.filter((arg) => typeof arg === "string")
    : [];
  const existingEnv =
    typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)
      ? (record.env as Record<string, string>)
      : undefined;
  const existingKey = serverLaunchKey(record.command, existingArgs, existingEnv);
  const entryKey = serverLaunchKey(entry.command, entry.args, entry.env);
  return (
    existingKey.entry === entryKey.entry &&
    JSON.stringify(existingKey.serverArgs) === JSON.stringify(entryKey.serverArgs)
  );
}

/**
 * Canonical launch identity of a pi MCP server entry: the resolved CLI entry
 * path plus the server args that follow it. A bare `trailstep` shim entry is
 * resolved through its `TRAILSTEP_CLI_ENTRY` env value; a bare shim without an
 * entry is compared on its forwarded args alone.
 */
function serverLaunchKey(
  command: string,
  args: readonly string[],
  env?: Record<string, string>,
): { entry: string | undefined; serverArgs: string[] } {
  const shimEntry = command === "trailstep" ? env?.TRAILSTEP_CLI_ENTRY : undefined;
  if (shimEntry !== undefined) {
    return { entry: shimEntry, serverArgs: [...args] };
  }
  if (command === "trailstep") {
    return { entry: undefined, serverArgs: [...args] };
  }
  return { entry: args[0], serverArgs: args.slice(1) };
}

function piEntriesEqual(existing: unknown, entry: PiMcpServerEntry): boolean {
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return false;
  }
  const record = existing as { exposure?: unknown; toolExposure?: unknown };
  if (record.exposure !== entry.exposure) {
    return false;
  }
  const existingTools =
    typeof record.toolExposure === "object" &&
    record.toolExposure !== null &&
    !Array.isArray(record.toolExposure)
      ? (record.toolExposure as Record<string, string>)
      : {};
  const entryTools = entry.toolExposure;
  const toolNames = new Set([...Object.keys(existingTools), ...Object.keys(entryTools)]);
  for (const toolName of toolNames) {
    if (existingTools[toolName] !== entryTools[toolName]) {
      return false;
    }
  }
  return true;
}

/**
 * Derives the CLI entry path from a launch spec: the entry is the first
 * argument when the server is launched through an interpreter, and unknown
 * for the bare `trailstep` shim.
 */
function deriveCliEntryPath(serverCommand: PiMcpLaunchSpec): string | undefined {
  if (serverCommand.command === "trailstep") {
    return undefined;
  }
  const first = serverCommand.args[0];
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function absoluteDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(dir);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteForShell(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
