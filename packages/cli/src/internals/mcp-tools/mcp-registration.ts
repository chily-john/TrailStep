import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
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
export const TRAILSTEP_MCP_SERVER_GLOBAL_NAME = "trailstep-global";

/**
 * Registered server name per scope: global registrations use a distinct name
 * so a follow-me global server never collides with a project-pinned `trailstep`
 * server in the agent's config.
 */
export function mcpServerNameForScope(scope: McpRegistrationScope): string {
  return scope === "global" ? TRAILSTEP_MCP_SERVER_GLOBAL_NAME : TRAILSTEP_MCP_SERVER_NAME;
}

const MCP_REGISTRATION_PROMPT_LABEL =
  "Register the TrailStep MCP server (trst_* workflow tools) with your coding agent?";

export interface McpServerLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export interface BuildTrailStepMcpServerCommandOptions {
  readonly projectDir: string;
  /** Project (default) and local pin `--project <absolute-dir>`; global omits `--project` so the server follows the agent client's cwd. */
  readonly scope?: McpRegistrationScope;
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
  /** Where to register the MCP server entry: project (default), local (project file gitignored), or global (user-level). */
  readonly scope?: McpRegistrationScope;
  /** Absolute path of the project's .gitignore file for local-scope registration. Defaults to `<projectDir>/.gitignore`. */
  readonly gitignorePath?: string;
  /** The entry add-mcp appends to .gitignore for local scope. Defaults to `.mcp.json`. */
  readonly gitignoreEntry?: string;
  /** Pass `null` to treat add-mcp as unresolvable and force the manual-command fallback. */
  readonly addMcpEntryPath?: string | null;
  /** Injectable add-mcp resolution seam so tests can simulate an unresolvable install. */
  readonly resolveAddMcpEntry?: () => string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nodeBinaryPath?: string;
  readonly cliEntryPath?: string;
}

export type McpRegistrationScope = "project" | "local" | "global";

export interface McpRegistrationOutcome {
  readonly status: "registered" | "declined" | "manual" | "failed";
  readonly manualCommand: string;
  readonly serverCommand: McpServerLaunchSpec;
  readonly agentTargets: readonly string[];
  readonly scope: McpRegistrationScope;
}

/**
 * Builds the TrailStep MCP server command with an absolute Node binary path and
 * an absolute CLI entry path. Paths that are already absolute are preserved
 * verbatim and are never reinterpreted as relative paths. Project and local
 * scope pin `trailstep mcp --project <absolute-dir>`; global scope omits
 * `--project` entirely so `createServer` defaults to the agent client's cwd
 * (follow-me global: current project's layered tools + global `~/.trailstep`
 * tools).
 */
export function buildTrailStepMcpServerCommand(
  options: BuildTrailStepMcpServerCommandOptions,
): McpServerLaunchSpec {
  const projectDir = absoluteProjectDir(options.projectDir);
  const scope = options.scope ?? "project";
  const serverArgs =
    scope === "global" ? (["mcp"] as const) : (["mcp", "--project", projectDir] as const);
  const nodeBinaryPath = options.nodeBinaryPath ?? process.execPath;
  const cliEntryPath = options.cliEntryPath ?? defaultCliEntryPath();
  if (cliEntryPath === undefined) {
    return { command: "trailstep", args: [...serverArgs] };
  }
  return {
    command: nodeBinaryPath,
    args: [cliEntryPath, ...serverArgs],
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
  readonly scope?: McpRegistrationScope;
}): McpRegistrationSpawnRequest {
  const scope = options.scope ?? "project";
  const args = [
    options.addMcpEntryPath,
    options.serverCommand.command,
    ...options.serverCommand.args.map((arg) => `--args=${arg}`),
    `--name=${mcpServerNameForScope(scope)}`,
    ...(options.agentTargets ?? []).flatMap((agent) => ["-a", agent]),
    ...scopeArgvForScope(scope),
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
  readonly scope?: McpRegistrationScope;
}): string {
  const parts = ["npx", "add-mcp", quoteForShell(options.serverCommand.command)];
  for (const arg of options.serverCommand.args) {
    parts.push(`--args=${quoteForShell(arg)}`);
  }
  parts.push(`--name=${mcpServerNameForScope(options.scope ?? "project")}`);
  for (const agent of options.agentTargets ?? []) {
    parts.push("-a", quoteForShell(agent));
  }
  for (const flag of scopeArgvForScope(options.scope ?? "project")) {
    parts.push(flag);
  }
  return parts.join(" ");
}

function scopeArgvForScope(scope: McpRegistrationScope): readonly string[] {
  switch (scope) {
    case "local":
      return ["--gitignore"];
    case "global":
      return ["--global"];
    default:
      return [];
  }
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
  const agentTargets = await detectMcpAgentTargets({
    projectDir: options.projectDir,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const buildForScope = (scope: McpRegistrationScope) => {
    const serverCommand = buildTrailStepMcpServerCommand({
      projectDir: options.projectDir,
      scope,
      ...(options.nodeBinaryPath === undefined ? {} : { nodeBinaryPath: options.nodeBinaryPath }),
      ...(options.cliEntryPath === undefined ? {} : { cliEntryPath: options.cliEntryPath }),
    });
    return {
      serverCommand,
      manualCommand: formatAddMcpManualCommand({ serverCommand, agentTargets, scope }),
    };
  };

  if (options.assumeYes === true || options.prompts === undefined) {
    const headlessScope = options.scope ?? "project";
    const { serverCommand, manualCommand } = buildForScope(headlessScope);
    options.io.writeLine(
      "Register the TrailStep MCP server manually by running this command in a terminal:",
    );
    options.io.writeLine(manualCommand);
    return { status: "manual", manualCommand, serverCommand, agentTargets, scope: headlessScope };
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
    return {
      status: "declined",
      manualCommand: offered.manualCommand,
      serverCommand: offered.serverCommand,
      agentTargets,
      scope: offeredScope,
    };
  }

  const scope = options.scope ?? (await promptRegistrationScope(options.prompts));
  // Rebuild for the resolved scope so every later message and the outcome
  // carry the scope-accurate server name, `--project` pinning, and scope flags.
  const { serverCommand, manualCommand } = scope === offeredScope ? offered : buildForScope(scope);
  if (scope === "local") {
    const gitignorePath = absoluteProjectDir(
      options.gitignorePath ?? join(options.projectDir, ".gitignore"),
    );
    const preview = await gitignoreAppendPreview(
      gitignorePath,
      options.gitignoreEntry ?? DEFAULT_GITIGNORE_ENTRY,
    );
    options.io.writeLine(`Local registration appends the --gitignore entry to ${gitignorePath}:`);
    options.io.writeLine(`  ${preview}`);
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
      };
    }
  } else if (scope === "global") {
    options.io.writeLine(
      "Global registration writes a user-level config; the server omits --project and follows the agent client's current project (its layered tools plus global ~/.trailstep tools).",
    );
  }

  const resolveAddMcpEntry = options.resolveAddMcpEntry ?? defaultAddMcpEntryPath;
  const addMcpEntryPath =
    options.addMcpEntryPath === undefined ? resolveAddMcpEntry() : options.addMcpEntryPath;
  if (addMcpEntryPath === undefined || addMcpEntryPath === null) {
    options.io.writeLine(
      "add-mcp could not be located for automatic registration. Register the TrailStep MCP server manually by running this command in a terminal:",
    );
    options.io.writeLine(manualCommand);
    return { status: "manual", manualCommand, serverCommand, agentTargets, scope };
  }

  const request = buildAddMcpSpawnRequest({
    serverCommand,
    projectDir: options.projectDir,
    addMcpEntryPath,
    agentTargets,
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
    });
    return { status: "failed", manualCommand, serverCommand, agentTargets, scope };
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
    return { status: "failed", manualCommand, serverCommand, agentTargets, scope };
  }

  options.io.writeLine(
    `add-mcp registered the TrailStep MCP server (${mcpServerNameForScope(scope)}) with your coding agent.`,
  );
  return { status: "registered", manualCommand, serverCommand, agentTargets, scope };
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

const SCOPE_CHOICES = [
  "Project (committed)",
  "Local (gitignored, stays on this machine)",
  "Global (user-level config)",
] as const;

/**
 * Asks where the MCP registration should live once the user accepted the
 * registration offer. The choice maps onto add-mcp argv flags: local appends
 * `--gitignore`, global appends `--global`, and project appends nothing.
 */
async function promptRegistrationScope(
  prompts: TrailStepCliPrompts,
): Promise<McpRegistrationScope> {
  const selected = await promptSelect(
    "Where should the TrailStep MCP server registration live?",
    SCOPE_CHOICES,
    prompts,
    "A registration scope answer is required.",
  );
  return scopeFromChoice(selected);
}

function scopeFromChoice(choice: string): McpRegistrationScope {
  if (choice.startsWith("Local")) {
    return "local";
  }
  if (choice.startsWith("Global")) {
    return "global";
  }
  return "project";
}

const DEFAULT_GITIGNORE_ENTRY = ".mcp.json";

/**
 * Shows the entry that add-mcp's `--gitignore` flag appends to the project's
 * .gitignore, noting when the entry is already listed.
 */
async function gitignoreAppendPreview(gitignorePath: string, entry: string): Promise<string> {
  try {
    const content = await readFile(gitignorePath, "utf8");
    const alreadyListed = content.split(/\r?\n/).some((line) => line.trim() === entry);
    return alreadyListed ? `${entry} (already listed)` : entry;
  } catch {
    return entry;
  }
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
 *
 * Packaging: `add-mcp` is a production dependency of `@trailstep/mcp` (not of
 * `@trailstep/cli` directly). The trade-off is that every `@trailstep/mcp`
 * install pulls in `add-mcp` even if the consumer never runs `trailstep
 * init`/`add`; in exchange, published installs of `@trailstep/cli` can always
 * resolve the add-mcp bin entry without a network `npx` fetch. Resolution
 * walks cli -> `@trailstep/mcp` package root -> `add-mcp`, using the package.json
 * entry (not the module entry) so it works even when `@trailstep/mcp`'s dist
 * has not been built.
 */
export function defaultAddMcpEntryPath(): string | undefined {
  const requireFromCli = createRequire(import.meta.url);
  const direct = tryResolvePackageJson("add-mcp", requireFromCli);
  if (direct !== undefined) {
    return packageBinEntry(direct);
  }
  const mcpPackageJson = tryResolvePackageJson("@trailstep/mcp", requireFromCli);
  if (mcpPackageJson === undefined) {
    return undefined;
  }
  const viaMcp = tryResolvePackageJson("add-mcp", createRequire(mcpPackageJson));
  return viaMcp === undefined ? undefined : packageBinEntry(viaMcp);
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
