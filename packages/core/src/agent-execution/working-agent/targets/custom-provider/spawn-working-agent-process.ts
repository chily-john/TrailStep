import { spawn } from "node:child_process";

import type { WorkingAgentProcessRunner } from "../../../../runtime/run-workflow/run-workflow.types.js";

export const spawnWorkingAgentProcess: WorkingAgentProcessRunner = async ({ command, args, cwd }) => {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
};
