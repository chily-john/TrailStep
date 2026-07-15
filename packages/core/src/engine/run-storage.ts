import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Event } from "./engine.types.js";

export async function createRunDirectory(options: {
  readonly cwd: string;
  readonly runName: string;
}): Promise<{ runId: string; runDir: string }> {
  const stepkitRoot = join(options.cwd, ".stepkit");
  const runsRoot = join(stepkitRoot, "runs");
  await mkdir(runsRoot, { recursive: true });
  await ensureStepkitGitignore(stepkitRoot);

  for (let suffix = 1; ; suffix += 1) {
    const runId = suffix === 1 ? options.runName : `${options.runName}-${suffix}`;
    const runDir = join(runsRoot, runId);

    try {
      await mkdir(runDir);
      return { runId, runDir };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }
}

export async function persistEvents(runDir: string, events: readonly Event[]): Promise<void> {
  const jsonl = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(join(runDir, "events.jsonl"), `${jsonl}\n`, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function ensureStepkitGitignore(stepkitRoot: string): Promise<void> {
  try {
    await writeFile(join(stepkitRoot, ".gitignore"), "*\n!.gitignore\n", { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }

    throw error;
  }
}
