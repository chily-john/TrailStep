import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { CliCommandContext } from "../../command-framework/command.types.js";

import {
  deleteAgent,
  listNamedAgentChoices,
  renameAgent,
  setAgent,
  writeNamedAgent,
} from "./agents-config.js";

function tmpDir(task: { readonly id: string }): string {
  return join("node_modules", ".tmp-trailstep-agents-config-tests", `${task.id}-${randomUUID()}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function contextFor(cwd: string, lines: string[] = []): CliCommandContext {
  return {
    cwd,
    homeDir: join(cwd, "home"),
    io: {
      writeLine: (line) => lines.push(line),
      writeError: () => undefined,
    },
  };
}

describe("renameAgent", () => {
  it("leaves the config unchanged when renaming references fails", async ({ task }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await writeJson(configPath, {
      agents: { reviewer: [{ provider: "claude", model: "sonnet" }] },
    });
    // An unreadable global scope makes `renameAgentRefs` throw. References are renamed before the
    // config is rewritten, so the failure has to leave the agent addressable under its old name.
    await mkdir(resolve(cwd, "home", ".trailstep", "config.json"), { recursive: true });

    await expect(
      renameAgent(
        { action: "rename", oldName: "reviewer", newName: "critic", scope: "project" },
        contextFor(cwd),
      ),
    ).rejects.toThrow();

    await expect(readJson(configPath)).resolves.toEqual({
      agents: { reviewer: [{ provider: "claude", model: "sonnet" }] },
    });
  });

  it("renames the entry together with the references that point at it", async ({ task }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    await writeJson(configPath, {
      agents: {
        reviewer: [{ provider: "claude", model: "sonnet" }],
        base: [{ ref: "reviewer" }],
      },
      workflows: { release: { agents: { reviewer: [{ ref: "reviewer" }] } } },
    });

    await expect(
      renameAgent(
        { action: "rename", oldName: "reviewer", newName: "critic", scope: "project" },
        contextFor(cwd),
      ),
    ).resolves.toBe(0);

    // The ref rewrite happens before the config rewrite; re-reading inside the update is what
    // keeps those renamed refs from being reverted by a stale snapshot.
    await expect(readJson(configPath)).resolves.toEqual({
      agents: {
        critic: [{ provider: "claude", model: "sonnet" }],
        base: [{ ref: "critic" }],
      },
      workflows: { release: { agents: { reviewer: [{ ref: "critic" }] } } },
    });
  });
});

describe("setAgent / writeNamedAgent / deleteAgent", () => {
  it("round-trips set then delete and pins the current empty-bucket behaviour", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const configPath = resolve(cwd, ".trailstep", "config.json");
    const context = contextFor(cwd);

    await setAgent(
      { action: "set", name: "reviewer", provider: "claude", model: "sonnet", scope: "project" },
      context,
    );
    await expect(readJson(configPath)).resolves.toEqual({
      agents: { reviewer: [{ provider: "claude", model: "sonnet" }] },
    });

    // Pinned: deleting the last agent leaves an empty `agents` bucket behind. Changing that is a
    // separate decision from the write-safety work here.
    await expect(
      deleteAgent({ action: "delete", name: "reviewer", scope: "project" }, context),
    ).resolves.toBe(0);
    await expect(readJson(configPath)).resolves.toEqual({ agents: {} });
  });

  it("prints exactly one confirmation line for writeNamedAgent", async ({ task }) => {
    const cwd = tmpDir(task);
    const lines: string[] = [];

    await writeNamedAgent(
      "project",
      "reviewer",
      [{ provider: "claude", model: "sonnet" }],
      contextFor(cwd, lines),
    );

    expect(lines).toEqual([`Wrote agent reviewer to ${join(cwd, ".trailstep", "config.json")}.`]);
    await expect(readJson(resolve(cwd, ".trailstep", "config.json"))).resolves.toEqual({
      agents: { reviewer: [{ provider: "claude", model: "sonnet" }] },
    });
  });
});

describe("listNamedAgentChoices", () => {
  it("only offers reserved size names that a scope actually configures", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(resolve(cwd, ".trailstep", "config.json"), {
      agents: {
        medium: [{ provider: "claude" }],
        reviewer: [{ provider: "claude" }],
      },
    });

    await expect(listNamedAgentChoices(contextFor(cwd))).resolves.toEqual(["medium", "reviewer"]);
  });

  it("returns an empty list when no scope configures an agent", async ({ task }) => {
    await expect(listNamedAgentChoices(contextFor(tmpDir(task)))).resolves.toEqual([]);
  });
});
