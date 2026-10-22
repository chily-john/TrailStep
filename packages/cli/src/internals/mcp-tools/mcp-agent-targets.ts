import { access } from "node:fs/promises";
import { join } from "node:path";

import { absoluteProjectDir } from "./mcp-server-command.js";

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
