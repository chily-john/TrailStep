import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".cmd", ".exe", ".bat", ""] as const;

export interface CliCommandSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedCliCommandSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ResolveCliCommandForSpawnOptions {
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
}

/**
 * Built-in provider CLIs are commonly npm-installed. On Windows, npm exposes
 * those CLIs as `.cmd` shims, which cannot be launched through Node's
 * `spawn(..., { shell: false })` by their bare command name. Resolve npm shims
 * to their underlying Node entrypoint when possible so provider prompts remain
 * argv values instead of being reinterpreted by a shell.
 */
export async function resolveCliCommandForSpawn(
  request: CliCommandSpawnRequest,
  options: ResolveCliCommandForSpawnOptions = {},
): Promise<ResolvedCliCommandSpawnRequest> {
  if ((options.platform ?? process.platform) !== "win32") {
    return request;
  }

  const commandPath = await findWindowsCommandPath(request.command, request.env ?? process.env);
  if (!commandPath) {
    return request;
  }

  if (isWindowsCommandShim(commandPath)) {
    const nodeScript = await readNpmCmdShimEntrypoint(commandPath);
    if (nodeScript) {
      return {
        command: options.execPath ?? process.execPath,
        args: [nodeScript, ...request.args],
      };
    }

    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandPath, ...request.args],
    };
  }

  return { command: commandPath, args: request.args };
}

async function findWindowsCommandPath(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const commandCandidates = windowsCommandCandidates(command);
  if (hasPathSeparator(command)) {
    return await firstExistingPath(commandCandidates);
  }

  const pathValue = readCaseInsensitiveEnv(env, "PATH");
  if (!pathValue) {
    return await firstExistingPath(commandCandidates);
  }

  for (const directory of pathValue.split(windowsPathDelimiter()).filter(Boolean)) {
    const found = await firstExistingPath(
      commandCandidates.map((candidate) => join(directory, candidate)),
    );
    if (found) {
      return found;
    }
  }

  return undefined;
}

function windowsCommandCandidates(command: string): readonly string[] {
  if (extname(command)) {
    return [command];
  }

  return WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${command}${extension}`);
}

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      try {
        await access(path, constants.F_OK);
        return path;
      } catch {
        // Keep looking.
      }
    }
  }

  return undefined;
}

async function readNpmCmdShimEntrypoint(commandPath: string): Promise<string | undefined> {
  let shim: string;
  try {
    shim = await readFile(commandPath, "utf8");
  } catch {
    return undefined;
  }

  const match = shim.match(/"%dp0%\\?([^"]+?\.js)"\s+%\*/i);
  if (!match?.[1]) {
    return undefined;
  }

  return join(dirname(commandPath), match[1].replace(/\\/g, "/"));
}

function isWindowsCommandShim(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function readCaseInsensitiveEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  return Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}

function windowsPathDelimiter(): string {
  return ";";
}
