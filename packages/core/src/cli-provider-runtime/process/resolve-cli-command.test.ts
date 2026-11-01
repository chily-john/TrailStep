import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCliCommandForSpawn } from "./resolve-cli-command.js";

async function tmpProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "trailstep-core-provider-shim-"));
}

async function writeEntrypoint(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "// entrypoint\n", "utf8");
}

async function writeShim(path: string, lines: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n"), "utf8");
}

describe("resolveCliCommandForSpawn", () => {
  it("leaves commands unchanged away from Windows", async () => {
    await expect(
      resolveCliCommandForSpawn(
        { command: "pi", args: ["--version"] },
        { platform: "linux", execPath: "/usr/bin/node" },
      ),
    ).resolves.toEqual({ command: "pi", args: ["--version"] });
  });

  it("resolves npm .cmd shims to their Node entrypoint on Windows", async () => {
    const projectDir = await tmpProject();
    const binDir = join(projectDir, "bin");
    const entrypoint = join(projectDir, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    await writeEntrypoint(entrypoint);
    await writeShim(join(binDir, "pi.cmd"), [
      "@ECHO off",
      "SETLOCAL",
      "CALL :find_dp0",
      // npm's generator: `%dp0%` (no tilde) behind an explicit `%_prog%`.
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
    ]);

    await expect(
      resolveCliCommandForSpawn(
        { command: "pi", args: ["--version"], env: { PATH: binDir } },
        { platform: "win32", execPath: "C:/node/node.exe" },
      ),
    ).resolves.toEqual({
      command: "C:/node/node.exe",
      args: [entrypoint, "--version"],
    });
  });

  // Regression test for the reported defect: pnpm writes `"%~dp0\..."` (with a
  // tilde) and no `%_prog%`, so the old npm-only regex found nothing and the
  // prompt fell through to `cmd.exe /c`, which re-parses it.
  it("resolves pnpm .cmd shims to their Node entrypoint on Windows", async () => {
    const projectDir = await tmpProject();
    const binDir = join(projectDir, "bin");
    const entrypoint = join(projectDir, "node_modules/@trailstep/fake-provider/dist/cli.js");
    await writeEntrypoint(entrypoint);
    await writeShim(join(binDir, "fake.cmd"), [
      "@ECHO off",
      "SETLOCAL",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%~dp0\\..\\node_modules\\@trailstep\\fake-provider\\dist\\cli.js" %*',
    ]);

    await expect(
      resolveCliCommandForSpawn(
        { command: "fake", args: ["--version"], env: { PATH: binDir } },
        { platform: "win32", execPath: "C:/node/node.exe" },
      ),
    ).resolves.toEqual({
      command: "C:/node/node.exe",
      args: [entrypoint, "--version"],
    });
  });

  it("throws when a shim's entrypoint does not exist", async () => {
    const projectDir = await tmpProject();
    const binDir = join(projectDir, "bin");
    const commandPath = join(binDir, "ghost.cmd");
    await writeShim(commandPath, ['"%~dp0\\..\\node_modules\\ghost\\dist\\cli.js" %*']);

    await expect(
      resolveCliCommandForSpawn(
        { command: "ghost", args: ["hello"], env: { PATH: binDir } },
        { platform: "win32", execPath: "C:/node/node.exe" },
      ),
    ).rejects.toThrow(commandPath);
  });

  // `cmd.exe /c` re-parses the argument list, so a shim we cannot read must
  // fail loudly rather than let the shell reinterpret a provider prompt.
  it("throws instead of falling back to cmd.exe for an unreadable shim", async () => {
    const projectDir = await tmpProject();
    const binDir = join(projectDir, "bin");
    const commandPath = join(binDir, "agent.cmd");
    await writeShim(commandPath, ["@echo off", "echo custom"]);

    await expect(
      resolveCliCommandForSpawn(
        { command: "agent", args: ["hello"], env: { PATH: binDir } },
        { platform: "win32", execPath: "C:/node/node.exe" },
      ),
    ).rejects.toThrow(commandPath);
  });

  it("passes shell metacharacters in args through unchanged", async () => {
    const projectDir = await tmpProject();
    const binDir = join(projectDir, "bin");
    const entrypoint = join(projectDir, "node_modules/@trailstep/fake-provider/dist/cli.js");
    await writeEntrypoint(entrypoint);
    await writeShim(join(binDir, "fake.cmd"), [
      "@ECHO off",
      '"%~dp0\\..\\node_modules\\@trailstep\\fake-provider\\dist\\cli.js" %*',
    ]);

    const args = [
      "--input",
      '{"prompt":"Use a & b | c < d > e %PATH% ^ !bang!"}',
      "plain",
    ] as const;

    const resolved = await resolveCliCommandForSpawn(
      { command: "fake", args, env: { PATH: binDir } },
      { platform: "win32", execPath: "C:/node/node.exe" },
    );

    expect(resolved).toEqual({ command: "C:/node/node.exe", args: [entrypoint, ...args] });
  });

  it("resolves a shim referenced by an absolute command path", async () => {
    const projectDir = await tmpProject();
    const binDir = join(projectDir, "bin");
    const entrypoint = join(projectDir, "node_modules/@trailstep/fake-provider/dist/cli.js");
    await writeEntrypoint(entrypoint);
    const commandPath = join(binDir, "fake.cmd");
    await writeShim(commandPath, [
      "@ECHO off",
      '"%~dp0\\..\\node_modules\\@trailstep\\fake-provider\\dist\\cli.js" %*',
    ]);

    await expect(
      resolveCliCommandForSpawn(
        { command: commandPath, args: ["go"], env: { PATH: "" } },
        { platform: "win32", execPath: "C:/node/node.exe" },
      ),
    ).resolves.toEqual({
      command: "C:/node/node.exe",
      args: [entrypoint, "go"],
    });
  });
});
