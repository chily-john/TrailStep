import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "./root.js";

const repoRoot = findRepoRoot();

function factoryPackageDirectories(): string[] {
  return readdirSync(join(repoRoot, "factory"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `factory/${entry.name}`)
    .filter((directory) => {
      try {
        readFileSync(join(repoRoot, directory, "package.json"));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

describe("factory packages", () => {
  it("stays private", () => {
    const directories = factoryPackageDirectories();
    expect(directories.length).toBeGreaterThan(0);

    const failures = directories.flatMap((directory) => {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, directory, "package.json"), "utf8"),
      ) as { name?: string; private?: boolean };

      if (manifest.private === true) {
        return [];
      }

      return [
        `${directory}/package.json: "${manifest.name ?? directory}" must set "private": true. ` +
          "Factory packages are maintenance-only and must never be published; `private` is the publish guard.",
      ];
    });

    expect(failures.join("\n")).toBe("");
  });
});
