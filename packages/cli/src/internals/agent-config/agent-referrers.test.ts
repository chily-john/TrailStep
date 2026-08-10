import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  blockDeleteWhenAgentReferrersExist,
  findAgentReferrers,
  renameAgentRefs,
} from "./agent-referrers.js";

function tmpDir(task: { readonly id: string }): string {
  return join("node_modules", ".tmp-trailstep-agent-referrers-tests", `${task.id}-${randomUUID()}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("agent referrer helpers", () => {
  it("finds and renames refs across local, project, and global config files", async ({ task }) => {
    const cwd = tmpDir(task);
    const homeDir = join(cwd, "home");
    await writeJson(join(cwd, ".trailstep", "config-local.json"), {
      agents: { local: [{ ref: "workerA" }, { provider: "claude" }] },
    });
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      agents: { shared: [{ ref: "workerA" }] },
      workflows: { release: { reviewer: [{ ref: "workerA" }] } },
    });
    await writeJson(join(homeDir, ".trailstep", "config.json"), {
      agents: { user: [{ ref: "workerA" }, { provider: "workerA" }] },
    });

    await expect(findAgentReferrers("workerA", { cwd, homeDir })).resolves.toEqual([
      { scope: "local", path: "agents.local[0]" },
      { scope: "project", path: "agents.shared[0]" },
      { scope: "project", path: "workflows.release.reviewer[0]" },
      { scope: "global", path: "agents.user[0]" },
    ]);

    await renameAgentRefs("workerA", "workerB", { cwd, homeDir });

    await expect(readJson(join(cwd, ".trailstep", "config-local.json"))).resolves.toEqual({
      agents: { local: [{ ref: "workerB" }, { provider: "claude" }] },
    });
    await expect(readJson(join(cwd, ".trailstep", "config.json"))).resolves.toEqual({
      agents: { shared: [{ ref: "workerB" }] },
      workflows: { release: { reviewer: [{ ref: "workerB" }] } },
    });
    await expect(readJson(join(homeDir, ".trailstep", "config.json"))).resolves.toEqual({
      agents: { user: [{ ref: "workerB" }, { provider: "workerA" }] },
    });
  });

  it("blocks delete when referrers exist", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".trailstep", "config.json"), {
      agents: { reviewer: [{ ref: "workerA" }] },
    });

    await expect(blockDeleteWhenAgentReferrersExist("workerA", { cwd })).rejects.toThrow(
      "Cannot delete agent workerA because it is referenced by project: agents.reviewer[0].",
    );
  });
});
