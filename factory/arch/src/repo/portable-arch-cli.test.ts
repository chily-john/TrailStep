import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "./root.js";

const repoRoot = findRepoRoot();
const LAUNCHER = "factory/arch/launch.mjs";
const LOADER = "factory/arch/typescript-loader.mjs";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function rootScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "trailstep-arch-cli-"));
  cleanup.push(directory);
  return directory;
}

function runFrom(directory: string, launcher: string): string {
  return execFileSync(process.execPath, [launcher, "--help"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("portable architecture CLI entry", () => {
  it("points the root arch scripts at the committed launcher", () => {
    const scripts = rootScripts();

    expect(scripts["arch:check"]).toBe(`node ${LAUNCHER}`);
    expect(scripts["arch:explain"]).toBe(`node ${LAUNCHER} --explain`);

    for (const name of ["verify", "verify:quick"]) {
      expect(scripts[name]).toContain("pnpm arch:check");
      expect(scripts[name]).not.toContain("factory/arch/dist");
    }
  });

  it("keeps the launcher and loader in source control", () => {
    expect(existsSync(join(repoRoot, LAUNCHER))).toBe(true);
    expect(existsSync(join(repoRoot, LOADER))).toBe(true);
  });

  it("runs from an unrelated working directory without a dist build", () => {
    const output = runFrom(temporaryDirectory(), join(repoRoot, LAUNCHER));

    expect(output).toContain("trailstep architecture gate");
    expect(output).toContain("Usage:");
  });

  it.skipIf(process.platform === "win32")("runs through a symlinked launcher", () => {
    const directory = temporaryDirectory();
    const link = join(directory, "arch-launch.mjs");
    symlinkSync(join(repoRoot, LAUNCHER), link);

    const output = runFrom(directory, link);

    expect(output).toContain("Usage:");
  });
});
