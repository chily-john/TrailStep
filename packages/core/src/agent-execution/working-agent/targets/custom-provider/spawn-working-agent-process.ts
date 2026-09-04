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
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: stdio === "pipe" ? ["ignore", "pipe", "inherit"] : "inherit",
      detached: process.platform !== "win32",
    });

    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    signal?.addEventListener("abort", () => terminateChildProcessTree(child), { once: true });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ exitCode: code ?? 1, ...(stdio === "pipe" ? { stdout } : {}) }),
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
