import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { McpRegistrationScope } from "./mcp-registration.types.js";
import { absoluteProjectDir } from "./mcp-server-command.js";

interface AgentMarker {
  readonly agent: string;
  readonly paths: readonly string[];
  /** Env var that overrides this agent's user-level home directory (user-level markers only). */
  readonly homeEnvVar?: string;
  /** Default user home segments under the user home base (user-level markers only). */
  readonly homeSegments?: readonly string[];
  /**
   * Marker's home lives under the XDG config root: `XDG_CONFIG_HOME` when set,
   * otherwise `<homeBase>/.config`. `homeSegments` keeps the leading `.config`
   * segment (replaced by the XDG root when set, keeping any trailing app
   * segments such as goose's) so the fallback stays `join(homeBase, ...)`.
   */
  readonly xdgConfig?: boolean;
}

const AGENT_PROJECT_MARKERS: readonly AgentMarker[] = [
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

/**
 * User-level marker probes for global-scope detection. Each marker names the
 * agent, the env override that re-points its user-level home, the default home
 * layout, and the candidate config paths that indicate the agent is configured
 * at user level.
 *
 * Gotchas covered here:
 * - goose is global-only and its user-level marker is a config file, not a dir.
 * - vscode / zed / goose keep app-level (user-level) directories.
 * - opencode reads `~/.config/opencode`, while kilo reads its XDG-style config.
 * - zed's config directory casing varies (`Zed` vs `zed`), so both are probed.
 */
const AGENT_USER_MARKERS: readonly AgentMarker[] = [
  {
    agent: "pi",
    homeEnvVar: "PI_CODING_AGENT_DIR",
    homeSegments: [".pi", "agent"],
    paths: ["mcp.json"],
  },
  { agent: "claude-code", homeSegments: [], paths: [".claude.json"] },
  { agent: "codex", homeEnvVar: "CODEX_HOME", homeSegments: [".codex"], paths: [""] },
  { agent: "cursor", homeSegments: [".cursor"], paths: [""] },
  { agent: "gemini-cli", homeSegments: [".gemini"], paths: [""] },
  {
    agent: "github-copilot-cli",
    homeEnvVar: "COPILOT_HOME",
    homeSegments: [".copilot"],
    paths: ["mcp.json"],
  },
  {
    agent: "goose",
    homeSegments: [".config", "goose"],
    xdgConfig: true,
    paths: ["config.yaml"],
  },
  { agent: "grok-build", homeEnvVar: "GROK_HOME", homeSegments: [".grok"], paths: ["mcp.json"] },
  {
    agent: "kilo-code",
    homeSegments: [".config"],
    xdgConfig: true,
    paths: ["kilo/mcp.json"],
  },
  {
    agent: "kimi-code",
    homeEnvVar: "KIMI_CODE_HOME",
    homeSegments: [".kimi-code"],
    paths: ["mcp.json"],
  },
  { agent: "kiro-cli", homeSegments: [".kiro"], paths: [""] },
  { agent: "mastracode", homeSegments: [".mastracode"], paths: [""] },
  {
    agent: "opencode",
    homeSegments: [".config"],
    xdgConfig: true,
    paths: ["opencode/opencode.json", "opencode/opencode.jsonc"],
  },
  { agent: "vscode", homeSegments: [".vscode"], paths: ["mcp.json"] },
  {
    agent: "zed",
    homeSegments: [".config"],
    xdgConfig: true,
    paths: ["zed/settings.json", "Zed/settings.json"],
  },
];

const AGENT_ENV_MARKERS: ReadonlyArray<{
  readonly agent: string;
  readonly envVar: string;
}> = [{ agent: "pi", envVar: "PI_CODING_AGENT_DIR" }];

export interface DetectMcpAgentTargetsOptions {
  readonly projectDir: string;
  /** `project` / `local` probe the project dir; `global` probes user-level markers. */
  readonly scope?: McpRegistrationScope;
  /** User home base used for global-scope detection (tests pass a hermetic dir). */
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Best-effort detection of the coding agent(s) to register with add-mcp. */
export async function detectMcpAgentTargets(
  options: DetectMcpAgentTargetsOptions,
): Promise<readonly string[]> {
  const projectDir = absoluteProjectDir(options.projectDir);
  const markers: readonly AgentMarker[] =
    options.scope === "global" ? AGENT_USER_MARKERS : AGENT_PROJECT_MARKERS;
  const targets: string[] = [];
  for (const marker of markers) {
    if (targets.includes(marker.agent)) {
      continue;
    }
    const candidates =
      options.scope === "global"
        ? userMarkerCandidates(marker, options)
        : marker.paths.map((markerPath) => join(projectDir, markerPath));
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
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

function userMarkerCandidates(
  marker: AgentMarker,
  options: Pick<DetectMcpAgentTargetsOptions, "homeDir" | "env">,
): string[] {
  const override =
    marker.homeEnvVar === undefined ? undefined : envValue(options.env, marker.homeEnvVar);
  const homeBase = options.homeDir ?? homedir();
  const xdgConfigHome =
    marker.xdgConfig === true ? envValue(options.env, "XDG_CONFIG_HOME") : undefined;
  const segments = marker.homeSegments ?? [];
  const home =
    override !== undefined
      ? absoluteDir(override)
      : xdgConfigHome !== undefined
        ? absoluteDir(join(xdgConfigHome, ...segments.slice(1)))
        : absoluteDir(join(homeBase, ...segments));
  const paths = marker.paths.length > 0 ? marker.paths : [""];
  const candidates: string[] = [];
  for (const path of paths) {
    candidates.push(join(home, path));
  }
  return candidates;
}

function absoluteDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(dir);
}

/**
 * Reads an env override: the injected env when one was provided (hermetic,
 * no `process.env` leakage), otherwise the real `process.env`.
 */
function envValue(
  env: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  const value = env === undefined ? process.env[name] : env[name];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
