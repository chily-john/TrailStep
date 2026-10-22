import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  McpRegistrationRunner,
  McpRegistrationScope,
  McpRegistrationSpawnRequest,
  McpRegistrationSpawnResult,
  McpServerLaunchSpec,
} from "./mcp-registration.types.js";
import { absoluteProjectDir, mcpServerNameForScope } from "./mcp-server-command.js";
import { quoteForShell } from "./mcp-shell-quoting.js";

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

export function scopeArgvForScope(scope: McpRegistrationScope): readonly string[] {
  switch (scope) {
    case "local":
      return ["--gitignore"];
    case "global":
      return ["--global"];
    default:
      return [];
  }
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

export const defaultMcpRegistrationRunner: McpRegistrationRunner = ({ command, args, cwd }) =>
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
