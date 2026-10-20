import { spawn } from "node:child_process";

import type { WorkingAgentProcessRunner } from "../../../../runtime/run-workflow/run-workflow.types.js";

export const spawnWorkingAgentProcess: WorkingAgentProcessRunner = async ({
  command,
  args,
  cwd,
  stdio,
  signal,
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

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        // Mirror captured stderr so live console output is preserved while the
        // stream is also retained for failure artifacts.
        process.stderr.write(chunk);
      });
    }

    signal?.addEventListener("abort", () => terminateChildProcessTree(child), { once: true });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        ...(capture ? { stdout } : {}),
        stderr,
      }),
    );
  });
};

function terminateChildProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
      "error",
      () => {
        child.kill();
      },
    );
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}
