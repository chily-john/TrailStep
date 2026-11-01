import { constants, existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

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
 * Built-in provider CLIs are commonly npm- or pnpm-installed. On Windows, both
 * package managers expose those CLIs as `.cmd` shims, which cannot be launched
 * through Node's `spawn(..., { shell: false })` by their bare command name.
 * Resolve readable shims to their underlying Node entrypoint so provider
 * prompts remain argv values instead of being reinterpreted by a shell. A shim
 * whose entrypoint cannot be read is refused: handing its argv to `cmd.exe`
 * would corrupt any prompt containing shell metacharacters.
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
    const nodeScript = readCmdShimEntrypoint(commandPath);
    if (nodeScript) {
      return {
        command: options.execPath ?? process.execPath,
        args: [nodeScript, ...request.args],
      };
    }

    // A shim we cannot read cannot be launched safely: `cmd.exe /c` re-parses
    // the argument list, so a prompt containing &, |, <, >, ^, % or ! is
    // reinterpreted by the shell. Refuse instead of corrupting the prompt.
    throw new Error(
      `Cannot launch the Windows shim ${commandPath} without a shell: no Node entrypoint could be read from it. ` +
        "Install the provider CLI with npm or pnpm, or point the provider's command at a .exe or a .js entrypoint.",
    );
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

/**
 * Extracts the Node entrypoint from an npm- or pnpm-generated `.cmd` shim.
 *
 * npm writes   `"%_prog%"  "%dp0%\..\pkg\cli.js" %*`
 * pnpm writes  `"%~dp0\..\pkg\cli.js" %*`
 *
 * Matching the JS path directly (rather than the whole line) tolerates both
 * generators, the `~` in `%~dp0`, and the differing quoting. A shim we can
 * read never goes through `cmd.exe`, which would re-parse the prompt's `&`,
 * `|`, `<`, `>` and `%` characters.
 */
function readCmdShimEntrypoint(commandPath: string): string | undefined {
  let shim: string;
  try {
    shim = readFileSync(commandPath, "utf8");
  } catch {
    return undefined;
  }

  const match =
    shim.match(/"%(?:~?dp0|_prog)%?\\?([^"]+?\.(?:js|mjs|cjs))"/i) ??
    shim.match(/"%_prog%"\s+"([^"]+?\.(?:js|mjs|cjs))"/i);
  const relative = match?.[1];
  if (!relative) {
    return undefined;
  }

  return resolveShimEntrypoint(dirname(commandPath), relative);
}

/**
 * Resolves a shim's embedded entrypoint path.
 *
 * pnpm writes a path relative to the shim's own directory (`..` is a real
 * segment); npm embeds `%dp0%`, which the regex already stripped and which is
 * also relative to the shim directory. Returning `undefined` when the
 * entrypoint does not exist lets the caller fail loudly instead of handing
 * Node a missing file.
 */
function resolveShimEntrypoint(shimDir: string, relative: string): string | undefined {
  const normalized = relative.replace(/\\/g, "/");
  const candidate = resolve(shimDir, normalized);
  return existsSync(candidate) ? candidate : undefined;
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
