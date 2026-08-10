import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliInputError, loadJsonInput } from "./load-run-input.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trailstep-cli-input-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("loadJsonInput", () => {
  it("loads inline JSON", async () => {
    await expect(loadJsonInput({ kind: "inline", json: '{"feature":"cli"}' })).resolves.toEqual({
      feature: "cli",
    });
  });

  it("loads JSON from a file", async () => {
    const dir = await createTempDir();
    const path = join(dir, "input.json");
    await writeFile(path, '{"from":"file"}', "utf8");

    await expect(loadJsonInput({ kind: "file", path })).resolves.toEqual({ from: "file" });
  });

  it("rejects invalid inline JSON", async () => {
    await expect(loadJsonInput({ kind: "inline", json: "{" })).rejects.toThrow(CliInputError);
  });

  it("rejects unreadable input files", async () => {
    await expect(loadJsonInput({ kind: "file", path: "./missing-input.json" })).rejects.toThrow(
      /unable to read/i,
    );
  });

  it("rejects invalid file JSON", async () => {
    const dir = await createTempDir();
    const path = join(dir, "input.json");
    await writeFile(path, "{", "utf8");

    await expect(loadJsonInput({ kind: "file", path })).rejects.toThrow(/invalid JSON/i);
  });
});
