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
  return join("node_modules", ".tmp-stepkit-agent-referrers-tests", `${task.id}-${randomUUID()}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("agent referrer helpers", () => {
  it("finds and renames refs across project-local, project, and user config files", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const homeDir = join(cwd, "home");
    await writeJson(join(cwd, ".stepkit", "config-local.json"), {
      agents: { local: { items: [{ ref: "workerA" }, { provider: "claude" }] } },
    });
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      agents: { shared: { items: [{ ref: "workerA" }] } },
      workflows: { release: { reviewer: { items: [{ ref: "workerA" }] } } },
    });
    await writeJson(join(homeDir, ".stepkit", "config.json"), {
      agents: { user: { items: [{ ref: "workerA" }, { provider: "workerA" }] } },
    });

    await expect(findAgentReferrers("workerA", { cwd, homeDir })).resolves.toEqual([
      { scope: "project-local", path: "agents.local.items[0]" },
      { scope: "project", path: "agents.shared.items[0]" },
      { scope: "project", path: "workflows.release.reviewer.items[0]" },
      { scope: "user", path: "agents.user.items[0]" },
    ]);

    await renameAgentRefs("workerA", "workerB", { cwd, homeDir });

    await expect(readJson(join(cwd, ".stepkit", "config-local.json"))).resolves.toEqual({
      agents: { local: { items: [{ ref: "workerB" }, { provider: "claude" }] } },
    });
    await expect(readJson(join(cwd, ".stepkit", "config.json"))).resolves.toEqual({
      agents: { shared: { items: [{ ref: "workerB" }] } },
      workflows: { release: { reviewer: { items: [{ ref: "workerB" }] } } },
    });
    await expect(readJson(join(homeDir, ".stepkit", "config.json"))).resolves.toEqual({
      agents: { user: { items: [{ ref: "workerB" }, { provider: "workerA" }] } },
    });
  });

  it("blocks delete when referrers exist", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      agents: { reviewer: { items: [{ ref: "workerA" }] } },
    });

    await expect(blockDeleteWhenAgentReferrersExist("workerA", { cwd })).rejects.toThrow(
      "Cannot delete agent workerA because it is referenced by project: agents.reviewer.items[0].",
    );
  });
});
