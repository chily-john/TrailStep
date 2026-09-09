import { stat } from "node:fs/promises";

export interface RunCwds {
  /** Root used for workflow/config-relative resolution and default artifact storage. */
  readonly projectCwd: string;
  /** Default execution cwd for steps and agent processes. */
  readonly cwd: string;
}

export async function resolveAndValidateRunCwds(options: {
  readonly projectCwd?: string;
  readonly cwd?: string;
}): Promise<RunCwds> {
  const projectCwd = options.projectCwd ?? options.cwd ?? process.cwd();
  const cwd = options.cwd ?? projectCwd;

  await validateDirectoryCwd(projectCwd, "projectCwd");
  if (cwd === projectCwd) {
    return { projectCwd, cwd };
  }

  await validateDirectoryCwd(cwd, "cwd");
  return { projectCwd, cwd };
}

export async function validateDirectoryCwd(cwd: string, label: string): Promise<void> {
  if (cwd.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }

  const stats = await stat(cwd).catch((error) => {
    throw new Error(`${label} must be an existing directory: ${cwd}`, { cause: error });
  });

  if (!stats.isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${cwd}`);
  }
}
