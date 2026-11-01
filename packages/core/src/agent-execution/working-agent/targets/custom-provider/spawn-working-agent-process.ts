import { spawn } from "node:child_process";

import type { WorkingAgentProcessRunner } from "../../../../runtime/run-workflow/run-workflow.types.js";
import { terminateChildProcessTree } from "../../../child-process/child-process-termination.js";
import { trackLiveChild } from "../../../child-process/live-children.js";

export const spawnWorkingAgentProcess: WorkingAgentProcessRunner = async ({
  command,
  args,
  cwd,
  stdio,
  signal,
  progress,
}) => {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const capture = stdio === "pipe";
    const child = spawn(command, args, {
      cwd,
      shell: false,
      // Stderr is always captured for failure artifacts while stdout keeps
      // the caller's requested behavior (live inherit vs. captured pipe).
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    progress?.markSpawned(child.pid);

    // Registered so a runner that dies (SIGKILL/OOM) does not leave an agent CLI writing
    // into an abandoned run directory; untracked on every settlement path below.
    const untrack = trackLiveChild(child);
    let termination: Promise<void> | undefined;

    const onAbort = (): void => {
      // Kick off termination once; the completion path awaits the same promise so the caller
      // never races a live child.
      termination ??= terminateChildProcessTree(child).catch(() => undefined);
    };
    if (signal?.aborted === true) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        progress?.recordOutput(chunk.length);
      });
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        progress?.recordOutput(chunk.length);
        // Mirror captured stderr so live console output is preserved while the
        // stream is also retained for failure artifacts.
        process.stderr.write(chunk);
      });
    }

    child.on("error", (error) => {
      untrack();
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      void (async () => {
        untrack();
        progress?.markExited();
        signal?.removeEventListener("abort", onAbort);
        // `close` fires after the stdio streams drained, but an abort-triggered
        // termination may still be in flight: awaiting it here is what guarantees the
        // caller's next attempt starts with a dead predecessor.
        if (termination !== undefined) {
          await termination;
        }
        resolve({
          exitCode: code ?? 1,
          ...(capture ? { stdout } : {}),
          stderr,
        });
      })();
    });
  });
};
