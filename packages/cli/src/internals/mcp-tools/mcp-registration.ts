import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { TrailStepCliIo, TrailStepCliPrompts } from "../command.types.js";
import { promptSelect } from "../prompts/prompt-helpers.js";

export interface McpRegistrationSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface McpRegistrationSpawnResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout?: string;
}

/** Injectable spawn seam so tests never run a real process. */
export type McpRegistrationRunner = (
  request: McpRegistrationSpawnRequest,
) => Promise<McpRegistrationSpawnResult>;

export const TRAILSTEP_MCP_SERVER_NAME = "trailstep";

const MCP_REGISTRATION_PROMPT_LABEL =
  "Register the TrailStep MCP server (trst_* workflow tools) with your coding agent?";

export interface McpServerLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export interface BuildTrailStepMcpServerCommandOptions {
  readonly projectDir: string;
  /** Absolute path of the Node binary used to launch the server. Defaults to the running process. */
  readonly nodeBinaryPath?: string;
  /** Absolute path of the TrailStep CLI entry script. Defaults to the running CLI entry. */
  readonly cliEntryPath?: string;
}

export interface OfferMcpRegistrationOptions {
  readonly projectDir: string;
  readonly io: TrailStepCliIo;
  readonly runner?: McpRegistrationRunner;
  readonly prompts?: TrailStepCliPrompts;
  /** Headless mode (e.g. `trailstep add --yes`): print the manual command instead of prompting. */
  readonly assumeYes?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nodeBinaryPath?: string;
  readonly cliEntryPath?: string;
  readonly addMcpEntryPath?: string;
}

export interface McpRegistrationOutcome {
  readonly status: "registered" | "declined" | "manual" | "failed";
  readonly manualCommand: string;
  readonly serverCommand: McpServerLaunchSpec;
  readonly agentTargets: readonly string[];
}

/**
 * Builds the `trailstep mcp --project <absolute-dir>` server command with an
 * absolute Node binary path and an absolute CLI entry path. Paths that are
 * already absolute are preserved verbatim and are never reinterpreted as
 * relative paths.
 */
export function buildTrailStepMcpServerCommand(
  options: BuildTrailStepMcpServerCommandOptions,
): McpServerLaunchSpec {
  const projectDir = absoluteProjectDir(options.projectDir);
  const nodeBinaryPath = options.nodeBinaryPath ?? process.execPath;
  const cliEntryPath = options.cliEntryPath ?? defaultCliEntryPath();
  if (cliEntryPath === undefined) {
    return { command: "trailstep", args: ["mcp", "--project", projectDir] };
  }
  return {
    command: nodeBinaryPath,
    args: [cliEntryPath, "mcp", "--project", projectDir],
  };
}

/**
 * Builds the add-mcp spawn request as a plain argv array: a path input becomes
 * an argv-array `{command, args}` server config (no shell), and server
 * arguments are forwarded through repeatable `--args=` values so flags such as
 * `--project` survive add-mcp's argument parsing. Never builds a shell string.
 */
export function buildAddMcpSpawnRequest(options: {
  readonly serverCommand: McpServerLaunchSpec;
  readonly projectDir: string;
  readonly addMcpEntryPath: string;
  readonly nodeBinaryPath?: string;
  readonly agentTargets?: readonly string[];
}): McpRegistrationSpawnRequest {
  const args = [
    options.addMcpEntryPath,
    options.serverCommand.command,
    ...options.serverCommand.args.map((arg) => `--args=${arg}`),
    `--name=${TRAILSTEP_MCP_SERVER_NAME}`,
    ...(options.agentTargets ?? []).flatMap((agent) => ["-a", agent]),
  ];
  return {
    command: options.nodeBinaryPath ?? process.execPath,
    args,
    cwd: absoluteProjectDir(options.projectDir),
  };
}

/** Renders the exact manual add-mcp command for a user's own terminal. */
export function formatAddMcpManualCommand(options: {
  readonly serverCommand: McpServerLaunchSpec;
  readonly agentTargets?: readonly string[];
}): string {
  const parts = ["npx", "add-mcp", quoteForShell(options.serverCommand.command)];
  for (const arg of options.serverCommand.args) {
    parts.push(`--args=${quoteForShell(arg)}`);
  }
  parts.push(`--name=${TRAILSTEP_MCP_SERVER_NAME}`);
  for (const agent of options.agentTargets ?? []) {
    parts.push("-a", quoteForShell(agent));
  }
  return parts.join(" ");
}

const AGENT_PROJECT_MARKERS: ReadonlyArray<{
  readonly agent: string;
  readonly paths: readonly string[];
}> = [
  { agent: "pi", paths: [".pi"] },
  { agent: "claude-code", paths: [".claude", ".mcp.json"] },
  { agent: "cursor", paths: [".cursor"] },
  { agent: "codex", paths: [".codex"] },
  { agent: "gemini-cli", paths: [".gemini"] },
  { agent: "github-copilot-cli", paths: [".github/mcp.json"] },
  { agent: "goose", paths: [".goose"] },
  { agent: "grok-build", paths: [".grok"] },
  { agent: "kilo-code", paths: [".kilo", ".kilocode"] },
  { agent: "kimi-code", paths: [".kimi-code"] },
  { agent: "kiro-cli", paths: [".kiro"] },
  { agent: "mastracode", paths: [".mastracode"] },
  { agent: "opencode", paths: ["opencode.jsonc", "opencode.json", ".opencode"] },
  { agent: "vscode", paths: [".vscode/mcp.json"] },
  { agent: "zed", paths: [".zed/settings.json"] },
];

const AGENT_ENV_MARKERS: ReadonlyArray<{
  readonly agent: string;
  readonly envVar: string;
}> = [{ agent: "pi", envVar: "PI_CODING_AGENT_DIR" }];

/** Best-effort detection of the coding agent(s) to register with add-mcp. */
export async function detectMcpAgentTargets(options: {
  readonly projectDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<readonly string[]> {
  const projectDir = absoluteProjectDir(options.projectDir);
  const targets: string[] = [];
  for (const marker of AGENT_PROJECT_MARKERS) {
    if (targets.includes(marker.agent)) {
      continue;
    }
    for (const markerPath of marker.paths) {
      if (await pathExists(join(projectDir, markerPath))) {
        targets.push(marker.agent);
        break;
      }
    }
  }
  for (const envMarker of AGENT_ENV_MARKERS) {
    if (options.env?.[envMarker.envVar] && !targets.includes(envMarker.agent)) {
      targets.push(envMarker.agent);
    }
  }
  return targets;
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
  const serverCommand = buildTrailStepMcpServerCommand({
    projectDir: options.projectDir,
    ...(options.nodeBinaryPath === undefined ? {} : { nodeBinaryPath: options.nodeBinaryPath }),
    ...(options.cliEntryPath === undefined ? {} : { cliEntryPath: options.cliEntryPath }),
  });
  const agentTargets = await detectMcpAgentTargets({
    projectDir: options.projectDir,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const manualCommand = formatAddMcpManualCommand({ serverCommand, agentTargets });

  if (options.assumeYes === true || options.prompts === undefined) {
    options.io.writeLine(
      "Register the TrailStep MCP server manually by running this command in a terminal:",
    );
    options.io.writeLine(manualCommand);
    return { status: "manual", manualCommand, serverCommand, agentTargets };
  }

  const promptLabel =
    agentTargets.length > 0
      ? `${MCP_REGISTRATION_PROMPT_LABEL} (detected: ${agentTargets.join(", ")})`
      : MCP_REGISTRATION_PROMPT_LABEL;
  const accepted = await promptConfirmDefaultYes(promptLabel, options.prompts);
  if (!accepted) {
    options.io.writeLine("Skipped TrailStep MCP server registration.");
    options.io.writeLine("You can register it later by running this command in a terminal:");
    options.io.writeLine(manualCommand);
    return { status: "declined", manualCommand, serverCommand, agentTargets };
  }

  const addMcpEntryPath = options.addMcpEntryPath ?? defaultAddMcpEntryPath();
  if (addMcpEntryPath === undefined) {
    options.io.writeLine(
      "add-mcp could not be located for automatic registration. Register the TrailStep MCP server manually by running this command in a terminal:",
    );
    options.io.writeLine(manualCommand);
    return { status: "manual", manualCommand, serverCommand, agentTargets };
  }

  const request = buildAddMcpSpawnRequest({
    serverCommand,
    projectDir: options.projectDir,
    addMcpEntryPath,
    agentTargets,
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
    });
    return { status: "failed", manualCommand, serverCommand, agentTargets };
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
    });
    return { status: "failed", manualCommand, serverCommand, agentTargets };
  }

  options.io.writeLine(
    `add-mcp registered the TrailStep MCP server (${TRAILSTEP_MCP_SERVER_NAME}) with your coding agent.`,
  );
  return { status: "registered", manualCommand, serverCommand, agentTargets };
}

function writeManualFallbackInstructions(
  io: TrailStepCliIo,
  options: {
    readonly serverCommand: McpServerLaunchSpec;
    readonly manualCommand: string;
    readonly reason: string;
  },
): void {
  io.writeLine(`Automatic MCP registration failed: ${options.reason}`);
  io.writeLine(
    "Register the TrailStep MCP server manually by running this exact command in a terminal:",
  );
  io.writeLine(options.manualCommand);
  io.writeLine(
    "Keep the printed paths exactly as written; they are absolute and must not be rewritten as relative paths.",
  );
  io.writeLine("The server command that will be registered is:");
  io.writeLine(formatServerCommandForDisplay(options.serverCommand));
}

function formatServerCommandForDisplay(serverCommand: McpServerLaunchSpec): string {
  return [quoteForShell(serverCommand.command), ...serverCommand.args.map(quoteForShell)].join(" ");
}

function describeSpawnFailure(error: unknown, exitCode?: number, output?: string): string {
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

function ttyInitFailed(result: McpRegistrationSpawnResult): boolean {
  return `${result.stderr ?? ""}\n${result.stdout ?? ""}`.includes("ERR_TTY_INIT_FAILED");
}

async function promptConfirmDefaultYes(
  label: string,
  prompts: TrailStepCliPrompts,
): Promise<boolean> {
  if (prompts.confirm !== undefined) {
    return prompts.confirm(label);
  }
  return (
    (await promptSelect(label, ["yes", "no"] as const, prompts, "A yes/no answer is required.")) ===
    "yes"
  );
}

function absoluteProjectDir(projectDir: string): string {
  return isAbsolute(projectDir) ? projectDir : resolve(projectDir);
}

function defaultCliEntryPath(): string | undefined {
  const entryPath = process.argv[1];
  if (typeof entryPath !== "string" || entryPath.trim().length === 0) {
    return undefined;
  }
  return isAbsolute(entryPath) ? entryPath : resolve(entryPath);
}

/**
 * Resolves add-mcp's Node entry script to an absolute path so it can be
 * spawned through an argv array without a shell (bare `npx add-mcp` wrappers
 * fail headless with ERR_TTY_INIT_FAILED).
 */
export function defaultAddMcpEntryPath(): string | undefined {
  const requireFromCli = createRequire(import.meta.url);
  const direct = tryResolvePackageJson("add-mcp", requireFromCli);
  if (direct !== undefined) {
    return packageBinEntry(direct);
  }
  const mcpEntry = tryResolvePackage("@trailstep/mcp", requireFromCli);
  if (mcpEntry === undefined) {
    return undefined;
  }
  const viaMcp = tryResolvePackageJson("add-mcp", createRequire(mcpEntry));
  return viaMcp === undefined ? undefined : packageBinEntry(viaMcp);
}

function tryResolvePackage(packageName: string, requireFrom: NodeJS.Require): string | undefined {
  try {
    return requireFrom.resolve(packageName);
  } catch {
    return undefined;
  }
}

function tryResolvePackageJson(
  packageName: string,
  requireFrom: NodeJS.Require,
): string | undefined {
  try {
    return requireFrom.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function packageBinEntry(packageJsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof parsed.bin === "string"
        ? parsed.bin
        : (Object.values(parsed.bin ?? {}).at(0) as string | undefined);
    return bin === undefined ? undefined : join(dirname(packageJsonPath), bin);
  } catch {
    return undefined;
  }
}

function quoteForShell(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const defaultMcpRegistrationRunner: McpRegistrationRunner = ({ command, args, cwd }) =>
  new Promise<McpRegistrationSpawnResult>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["inherit", "inherit", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, stderr }));
  });
