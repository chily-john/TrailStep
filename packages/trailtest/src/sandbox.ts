import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createdRoots: string[] = [];
let exitHookInstalled = false;

/**
 * Create a disposable sandbox project directory under the OS tmpdir.
 * Directories are removed automatically when the test process exits, or
 * earlier via `cleanupTmpProjects()`.
 */
export function tmpProject(prefix = "trailstep-project-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  createdRoots.push(root);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      removeRegisteredRoots();
    });
  }
  return root;
}

/**
 * Create a disposable git sandbox: a fresh repo with user config, a
 * `.trailstep/.gitignore` that keeps run artifacts out of the worktree, and a
 * clean `initial commit`, so workflow preflight checks pass immediately.
 */
export function tmpGitRepo(prefix = "trailstep-repo-"): string {
  const root = tmpProject(prefix);
  git(root, ["init"]);
  git(root, ["config", "user.email", "trailstep@example.test"]);
  git(root, ["config", "user.name", "TrailStep Test"]);
  mkdirSync(join(root, ".trailstep"), { recursive: true });
  writeFileSync(join(root, ".trailstep", ".gitignore"), "*\n!.gitignore\n", "utf8");
  writeFileSync(join(root, "README.md"), "# test repo\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "initial commit"]);
  return root;
}

/** Remove every sandbox directory created so far by `tmpProject`/`tmpGitRepo`. */
export function cleanupTmpProjects(): void {
  removeRegisteredRoots();
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

function removeRegisteredRoots(): void {
  for (const root of createdRoots.splice(0)) {
    if (!existsSync(root)) {
      continue;
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: another handle may still own the directory at exit.
    }
  }
}
