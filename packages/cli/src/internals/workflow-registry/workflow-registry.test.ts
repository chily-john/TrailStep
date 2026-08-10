import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  configPathForScope,
  deleteWorkflowRegistryEntry,
  findExistingRegistrationScope,
  listRegisteredWorkflowEntries,
  readRawStepKitConfigFile,
  toMutableWorkflowRegistry,
  writeRawStepKitConfigFile,
} from "./workflow-registry.js";

function tmpDir(task: { readonly id: string }): string {
  return join("node_modules", ".tmp-trailstep-workflow-registry-tests", `${task.id}-${randomUUID()}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("configPathForScope", () => {
  it("resolves project scope to <cwd>/.stepkit/config.json", () => {
    expect(configPathForScope("project", { cwd: "/repo" })).toBe(
      join("/repo", ".stepkit", "config.json"),
    );
  });

  it("resolves local scope to <cwd>/.stepkit/config-local.json", () => {
    expect(configPathForScope("local", { cwd: "/repo" })).toBe(
      join("/repo", ".stepkit", "config-local.json"),
    );
  });

  it("resolves global scope to <homeDir>/.stepkit/config.json", () => {
    expect(configPathForScope("global", { cwd: "/repo", homeDir: "/home/me" })).toBe(
      join("/home/me", ".stepkit", "config.json"),
    );
  });
});

describe("readRawStepKitConfigFile / writeRawStepKitConfigFile", () => {
  it("returns an empty object when the file does not exist", async ({ task }) => {
    const path = join(tmpDir(task), ".stepkit", "config.json");
    await expect(readRawStepKitConfigFile(path)).resolves.toEqual({});
  });

  it("round-trips a written config through mkdir -p and pretty-printed JSON", async ({ task }) => {
    const path = join(tmpDir(task), ".stepkit", "config.json");
    await writeRawStepKitConfigFile(path, { workflows: { project: { review: "./review.mjs" } } });

    await expect(readRawStepKitConfigFile(path)).resolves.toEqual({
      workflows: { project: { review: "./review.mjs" } },
    });
    await expect(readFile(path, "utf8")).resolves.toMatch(/\n$/);
  });
});

describe("toMutableWorkflowRegistry", () => {
  it("preserves non-string sibling keys alongside string registry leaves", () => {
    const registry = toMutableWorkflowRegistry({
      project: { review: "./review.mjs" },
      release: { workingAgent: "builder", limits: { retries: 1 } },
    });

    expect(registry).toEqual({
      project: { review: "./review.mjs" },
      release: { workingAgent: "builder", limits: { retries: 1 } },
    });
  });

  it("returns an empty object for non-record input", () => {
    expect(toMutableWorkflowRegistry(undefined)).toEqual({});
    expect(toMutableWorkflowRegistry("nope")).toEqual({});
  });
});

describe("deleteWorkflowRegistryEntry", () => {
  it("deletes the one entry and removes an emptied namespace bucket", () => {
    const result = deleteWorkflowRegistryEntry(
      { acme: { review: "./review.mjs" } },
      "acme",
      "review",
    );
    expect(result).toEqual({});
  });

  it("keeps the namespace bucket when sibling keys remain", () => {
    const result = deleteWorkflowRegistryEntry(
      { acme: { review: "./review.mjs", cleanup: "./cleanup.mjs" } },
      "acme",
      "review",
    );
    expect(result).toEqual({ acme: { cleanup: "./cleanup.mjs" } });
  });

  it("does not touch sibling object-valued keys in the same bucket", () => {
    const result = deleteWorkflowRegistryEntry(
      { acme: { review: "./review.mjs", workingAgent: "builder" } },
      "acme",
      "review",
    );
    expect(result).toEqual({ acme: { workingAgent: "builder" } });
  });

  it("is a no-op when the entry does not exist", () => {
    const workflows = { acme: { review: "./review.mjs" } };
    expect(deleteWorkflowRegistryEntry(workflows, "acme", "missing")).toBe(workflows);
    expect(deleteWorkflowRegistryEntry(workflows, "missing", "review")).toBe(workflows);
  });
});

describe("listRegisteredWorkflowEntries", () => {
  it("reads all three scope files independently and tags each entry with its origin scope", async ({
    task,
  }) => {
    const cwd = tmpDir(task);
    const homeDir = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });
    await writeJson(join(cwd, ".stepkit", "config-local.json"), {
      workflows: { project: { scratch: "./scratch.mjs" } },
    });
    await writeJson(join(homeDir, ".stepkit", "config.json"), {
      workflows: { global: { deploy: "./deploy.mjs" } },
    });

    const entries = await listRegisteredWorkflowEntries({ cwd, homeDir });

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          scope: "local",
          namespace: "project",
          name: "scratch",
          targetRef: "./scratch.mjs",
        },
        { scope: "project", namespace: "project", name: "review", targetRef: "./review.mjs" },
        { scope: "global", namespace: "global", name: "deploy", targetRef: "./deploy.mjs" },
      ]),
    );
    expect(entries).toHaveLength(3);
  });

  it("returns an empty list when no config files exist", async ({ task }) => {
    const cwd = tmpDir(task);
    await expect(listRegisteredWorkflowEntries({ cwd, homeDir: tmpDir(task) })).resolves.toEqual(
      [],
    );
  });

  it("ignores non-string leaves (per-workflow agent config) when enumerating", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: {
        project: { review: "./review.mjs" },
        release: { agents: { reviewer: [{ provider: "local" }] } },
      },
    });

    const entries = await listRegisteredWorkflowEntries({ cwd, homeDir: tmpDir(task) });
    expect(entries).toEqual([
      { scope: "project", namespace: "project", name: "review", targetRef: "./review.mjs" },
    ]);
  });
});

describe("findExistingRegistrationScope", () => {
  it("checks both project files when scope is project", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config-local.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });

    await expect(
      findExistingRegistrationScope("project", "review", "project", { cwd, homeDir: tmpDir(task) }),
    ).resolves.toBe("local");
  });

  it("checks both project files when scope is local", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { project: { review: "./review.mjs" } },
    });

    await expect(
      findExistingRegistrationScope("project", "review", "local", {
        cwd,
        homeDir: tmpDir(task),
      }),
    ).resolves.toBe("project");
  });

  it("only checks the global file when scope is global", async ({ task }) => {
    const cwd = tmpDir(task);
    await writeJson(join(cwd, ".stepkit", "config.json"), {
      workflows: { global: { review: "./review.mjs" } },
    });
    const homeDir = tmpDir(task);
    await writeJson(join(homeDir, ".stepkit", "config.json"), {
      workflows: { global: { deploy: "./deploy.mjs" } },
    });

    await expect(
      findExistingRegistrationScope("global", "review", "global", { cwd, homeDir }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when nothing matches", async ({ task }) => {
    await expect(
      findExistingRegistrationScope("project", "review", "project", {
        cwd: tmpDir(task),
        homeDir: tmpDir(task),
      }),
    ).resolves.toBeUndefined();
  });
});
