import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PackageCommandResult, PackageCommandRunner } from "../command.types.js";

export type PackageManagerName = "pnpm" | "npm" | "yarn" | "bun";

export type PackageDependencySaveType = "dependencies" | "devDependencies";

export interface PackageManagerCommand {
  command: PackageManagerName;
  args: readonly string[];
}

export interface PackageManagerDetection {
  name: PackageManagerName;
  installCommand: { command: PackageManagerName; args: ["install"] };
  warnings: string[];
}

export interface PackageManagerDetectionOptions {
  cwd: string;
}

const lockfileManagers: ReadonlyArray<{ lockfile: string; name: PackageManagerName }> = [
  { lockfile: "pnpm-lock.yaml", name: "pnpm" },
  { lockfile: "package-lock.json", name: "npm" },
  { lockfile: "yarn.lock", name: "yarn" },
  { lockfile: "bun.lock", name: "bun" },
  { lockfile: "bun.lockb", name: "bun" },
];

export async function detectPackageManager({
  cwd,
}: PackageManagerDetectionOptions): Promise<PackageManagerDetection> {
  for (const candidate of lockfileManagers) {
    if (await fileExists(join(cwd, candidate.lockfile))) {
      return createDetection(candidate.name);
    }
  }

  const packageManagerName = await readPackageManagerName(cwd);
  if (packageManagerName) {
    return createDetection(packageManagerName);
  }

  return createDetection("npm", ["No lockfile or packageManager field found; defaulting to npm."]);
}

export interface PackageInstallRunnerOptions {
  cwd: string;
  packageCommandRunner?: PackageCommandRunner;
}

export function createPackageAddCommand({
  packageManager,
  saveType,
  packageSpec,
  workspaceRoot = false,
}: {
  packageManager: PackageManagerName;
  saveType: PackageDependencySaveType;
  packageSpec: string;
  workspaceRoot?: boolean;
}): PackageManagerCommand {
  if (packageManager === "npm") {
    return {
      command: packageManager,
      args: ["install", saveType === "devDependencies" ? "--save-dev" : "--save", packageSpec],
    };
  }

  if (packageManager === "pnpm") {
    const workspaceRootArgs = workspaceRoot ? ["--workspace-root"] : [];
    return {
      command: packageManager,
      args:
        saveType === "devDependencies"
          ? ["add", "--save-dev", ...workspaceRootArgs, packageSpec]
          : ["add", ...workspaceRootArgs, packageSpec],
    };
  }

  return {
    command: packageManager,
    args: saveType === "devDependencies" ? ["add", "--dev", packageSpec] : ["add", packageSpec],
  };
}

export async function isPnpmWorkspaceRoot({ cwd }: { cwd: string }): Promise<boolean> {
  return fileExists(join(cwd, "pnpm-workspace.yaml"));
}

export function createPackageRemoveCommand({
  packageManager,
  packageName,
  workspaceRoot = false,
}: {
  packageManager: PackageManagerName;
  packageName: string;
  workspaceRoot?: boolean;
}): PackageManagerCommand {
  if (packageManager === "pnpm") {
    return {
      command: packageManager,
      args: workspaceRoot ? ["remove", "--workspace-root", packageName] : ["remove", packageName],
    };
  }

  return {
    command: packageManager,
    args: [packageManager === "npm" ? "uninstall" : "remove", packageName],
  };
}

export function createPackageInstallRunner({
  cwd,
  packageCommandRunner = defaultPackageCommandRunner,
}: PackageInstallRunnerOptions): () => Promise<PackageCommandResult> {
  return async () => {
    const detection = await detectPackageManager({ cwd });
    return packageCommandRunner({
      command: detection.installCommand.command,
      args: detection.installCommand.args,
      cwd,
    });
  };
}

export const defaultPackageCommandRunner: PackageCommandRunner = async ({ command, args, cwd }) => {
  const processCommand = packageCommandProcessForPlatform(command, args);
  const child = spawn(processCommand.command, processCommand.args, { cwd, shell: false });
  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

  return { exitCode, stdout, stderr };
};

function packageCommandProcessForPlatform(
  command: string,
  args: readonly string[],
): { command: string; args: readonly string[] } {
  if (process.platform === "win32" && isPackageManagerName(command)) {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
  }
  return { command, args };
}

function createDetection(
  name: PackageManagerName,
  warnings: string[] = [],
): PackageManagerDetection {
  return { name, installCommand: { command: name, args: ["install"] }, warnings };
}

async function readPackageManagerName(cwd: string): Promise<PackageManagerName | undefined> {
  try {
    const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    if (typeof packageJson.packageManager !== "string") {
      return undefined;
    }
    const name = packageJson.packageManager.split("@")[0] ?? "";
    if (isPackageManagerName(name)) {
      return name;
    }
    return undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isPackageManagerName(value: string): value is PackageManagerName {
  return value === "pnpm" || value === "npm" || value === "yarn" || value === "bun";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
