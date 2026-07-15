import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunDirectory } from "./run-storage.js";

describe("createRunDirectory", () => {
  it("creates a .stepkit/.gitignore file that ignores everything except itself", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-run-storage-"));

    await createRunDirectory({ cwd, runName: "first-run" });

    const gitignorePath = join(cwd, ".stepkit", ".gitignore");
    const contents = await readFile(gitignorePath, "utf8");
    expect(contents).toBe("*\n!.gitignore\n");
  });

  it("does not throw or corrupt the .gitignore file on a second run in the same cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-run-storage-"));

    await createRunDirectory({ cwd, runName: "first-run" });
    const gitignorePath = join(cwd, ".stepkit", ".gitignore");
    const firstContents = await readFile(gitignorePath, "utf8");

    await expect(createRunDirectory({ cwd, runName: "second-run" })).resolves.toMatchObject({
      runId: "second-run",
    });

    const secondContents = await readFile(gitignorePath, "utf8");
    expect(secondContents).toBe(firstContents);
    expect(secondContents).toBe("*\n!.gitignore\n");
  });
});
