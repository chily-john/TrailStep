import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const INSTALL_ROOT_SNAPSHOT_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

interface WorkflowPackageInstallFileSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly contents?: Uint8Array;
}

interface WorkflowPackageInstallDirectorySnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly backupRoot?: string;
  readonly backupPath?: string;
}

export interface WorkflowPackageInstallSnapshot {
  readonly installRoot: string;
  readonly packageName?: string;
  readonly files: readonly WorkflowPackageInstallFileSnapshot[];
  readonly packageDirectory?: WorkflowPackageInstallDirectorySnapshot;
}

export interface CreateWorkflowPackageInstallSnapshotOptions {
  readonly installRoot: string;
  readonly packageName?: string;
}

export async function createWorkflowPackageInstallSnapshot({
  installRoot,
  packageName,
}: CreateWorkflowPackageInstallSnapshotOptions): Promise<WorkflowPackageInstallSnapshot> {
  const files = await Promise.all(
    INSTALL_ROOT_SNAPSHOT_FILES.map((fileName) => snapshotFile(join(installRoot, fileName))),
  );
  const packageDirectory =
    packageName === undefined
      ? undefined
      : await snapshotDirectory(packageDirectoryPath(installRoot, packageName));

  return {
    installRoot,
    ...(packageName === undefined ? {} : { packageName }),
    files,
    ...(packageDirectory === undefined ? {} : { packageDirectory }),
  };
}

export async function rollbackWorkflowPackageInstall(
  snapshot: WorkflowPackageInstallSnapshot,
): Promise<void> {
  const failures: string[] = [];

  for (const file of snapshot.files) {
    try {
      await restoreFile(file);
    } catch (error) {
      failures.push(formatRollbackFailure(file.path, error));
    }
  }

  if (snapshot.packageDirectory !== undefined) {
    try {
      await restoreDirectory(snapshot.packageDirectory, snapshot.installRoot);
    } catch (error) {
      failures.push(formatRollbackFailure(snapshot.packageDirectory.path, error));
    }
  }

  try {
    await removeDirectoryBackups(snapshot);
  } catch (error) {
    failures.push(formatRollbackFailure("temporary rollback backup", error));
  }

  if (failures.length > 0) {
    throw new Error(`Package install rollback incomplete: ${failures.join("; ")}`);
  }
}

async function snapshotFile(path: string): Promise<WorkflowPackageInstallFileSnapshot> {
  try {
    return { path, existed: true, contents: await readFile(path) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { path, existed: false };
    }
    throw error;
  }
}

async function snapshotDirectory(path: string): Promise<WorkflowPackageInstallDirectorySnapshot> {
  try {
    await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { path, existed: false };
    }
    throw error;
  }

  const backupRoot = await mkdtemp(join(tmpdir(), "trailstep-package-rollback-"));
  const backupPath = join(backupRoot, "package");
  await cp(path, backupPath, { recursive: true, force: true });
  return { path, existed: true, backupRoot, backupPath };
}

async function restoreFile(snapshot: WorkflowPackageInstallFileSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.path, { force: true });
    return;
  }

  if (snapshot.contents === undefined) {
    throw new Error("snapshot contents were missing");
  }
  await mkdir(dirname(snapshot.path), { recursive: true });
  await writeFile(snapshot.path, snapshot.contents);
}

async function restoreDirectory(
  snapshot: WorkflowPackageInstallDirectorySnapshot,
  installRoot: string,
): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.path, { recursive: true, force: true });
    await removeEmptyPackageParentDirectories(snapshot.path, installRoot);
    return;
  }

  if (snapshot.backupPath === undefined) {
    throw new Error("directory backup path was missing");
  }
  await rm(snapshot.path, { recursive: true, force: true });
  await mkdir(dirname(snapshot.path), { recursive: true });
  await cp(snapshot.backupPath, snapshot.path, { recursive: true, force: true });
}

async function removeDirectoryBackups(snapshot: WorkflowPackageInstallSnapshot): Promise<void> {
  const backupRoot = snapshot.packageDirectory?.backupRoot;
  if (backupRoot !== undefined) {
    await rm(backupRoot, { recursive: true, force: true });
  }
}

async function removeEmptyPackageParentDirectories(
  packagePath: string,
  installRoot: string,
): Promise<void> {
  const nodeModulesPath = join(installRoot, "node_modules");
  let currentPath = dirname(packagePath);

  while (currentPath !== nodeModulesPath) {
    let entries: string[];
    try {
      entries = await readdir(currentPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    if (entries.length > 0) {
      return;
    }

    await rm(currentPath, { recursive: true, force: true });
    currentPath = dirname(currentPath);
  }
}

function packageDirectoryPath(installRoot: string, packageName: string): string {
  return join(installRoot, "node_modules", ...packageName.split("/"));
}

function formatRollbackFailure(path: string, error: unknown): string {
  return `${path}: ${error instanceof Error ? error.message : "unknown error"}`;
}

function isNodeError(error: unknown): error is { readonly code: string } {
  return typeof error === "object" && error !== null && "code" in error;
}
