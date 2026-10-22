import type { TrailStepCliIo, TrailStepCliPrompts } from "../command-framework/command.types.js";

/** Where the MCP server registration is written. */
export type McpRegistrationScope = "project" | "local" | "global";

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

export interface McpRegistrationOutcome {
  readonly status: "registered" | "declined" | "manual" | "failed";
  readonly manualCommand: string;
  readonly serverCommand: McpServerLaunchSpec;
  readonly agentTargets: readonly string[];
  readonly scope: McpRegistrationScope;
  /** pi-native manual command (`pi mcp add ...`) when pi is a detected target. */
  readonly piManualCommand?: string;
  /** add-mcp manual command for the remaining (non-pi) agents, when any. */
  readonly addMcpManualCommand?: string;
}
