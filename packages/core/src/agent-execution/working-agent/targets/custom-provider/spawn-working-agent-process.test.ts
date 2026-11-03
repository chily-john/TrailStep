import { describe, expect, it } from "vitest";

import { spawnWorkingAgentProcess } from "./spawn-working-agent-process.js";

const baseRequest = {
  command: process.execPath,
  cwd: process.cwd(),
  shell: false as const,
  promptFile: "unused-prompt.md",
  outputFile: "unused-output.json",
};

describe("spawnWorkingAgentProcess", () => {
  it("captures all of stdout and resolves only after the child closed", async () => {
    const result = await spawnWorkingAgentProcess({
      ...baseRequest,
      // Use write callback so child waits for stdout to drain before exiting.
      // Without this, CI (Linux 64KB pipe buffer) truncates the 200KB write.
      args: ["-e", "process.stdout.write('x'.repeat(200000), () => process.exit(0))"],
      stdio: "pipe",
    });

    expect(result.exitCode).toBe(0);
    // `exit` fires before stdio drains; resolving on it instead of `close` would truncate.
    expect(result.stdout?.length).toBe(200_000);
  });

  it("terminates the child when the signal aborts and resolves after it is gone", async () => {
    const controller = new AbortController();
    const pending = spawnWorkingAgentProcess({
      ...baseRequest,
      args: ["-e", "setInterval(() => {}, 1000)"],
      stdio: "pipe",
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);
    const result = await pending;

    expect(result.exitCode).not.toBe(0);
  });
});
