import { isAbsolute, resolve } from "node:path";

import type {
  BuildTrailStepMcpServerCommandOptions,
  McpRegistrationScope,
  McpServerLaunchSpec,
} from "./mcp-registration.types.js";

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

export function absoluteProjectDir(projectDir: string): string {
  return isAbsolute(projectDir) ? projectDir : resolve(projectDir);
}

export function defaultCliEntryPath(): string | undefined {
  const entryPath = process.argv[1];
  if (typeof entryPath !== "string" || entryPath.trim().length === 0) {
    return undefined;
  }
  return isAbsolute(entryPath) ? entryPath : resolve(entryPath);
}
