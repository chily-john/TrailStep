import { type TerminableChild, terminateChildProcessTree } from "./child-process-termination.js";

/**
 * Tracks every agent child process this process has started, so a crash or a signal can take
 * them down instead of leaving agent CLIs running against an abandoned run directory.
 *
 * Cleanup is best-effort and synchronous-at-exit on purpose: `process.on("exit")` cannot await.
 * The async `killAllLiveChildren` is for graceful paths (SIGINT/SIGTERM) where awaiting is
 * possible.
 */
const live = new Set<TerminableChild>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of live) {
      const pid = child.pid;
      if (pid === undefined || pid <= 0) {
        continue;
      }
      try {
        if (process.platform === "win32") {
          // Synchronous best effort; there is no time to await taskkill here.
          child.kill();
        } else {
          process.kill(-pid, "SIGKILL");
        }
      } catch {
        // Already gone.
      }
    }
    live.clear();
  });
}

export function trackLiveChild(child: TerminableChild): () => void {
  installExitHook();
  live.add(child);
  return () => {
    live.delete(child);
  };
}

export async function killAllLiveChildren(): Promise<void> {
  const children = [...live];
  live.clear();
  await Promise.all(
    children.map((child) =>
      terminateChildProcessTree(child).catch(() => {
        // Best effort: a child that cannot be killed must not mask the real shutdown reason.
      }),
    ),
  );
}

/** Test seam: number of currently tracked children. */
export function liveChildCount(): number {
  return live.size;
}
