import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCliCommandForSpawn } from "./resolve-cli-command.js";

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
    const binDir = await mkdtemp(join(tmpdir(), "stepkit-core-provider-shim-"));
    await writeFile(
      join(binDir, "pi.cmd"),
      [
        "@ECHO off",
        "SETLOCAL",
        "CALL :find_dp0",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*',
      ].join("\n"),
      "utf8",
    );

    await expect(
      resolveCliCommandForSpawn(
        { command: "pi", args: ["--version"], env: { PATH: binDir } },
        { platform: "win32", execPath: "C:/node/node.exe" },
      ),
    ).resolves.toEqual({
      command: "C:/node/node.exe",
      args: [join(binDir, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--version"],
    });
  });

  it("falls back to cmd.exe for non-npm command shims", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "stepkit-core-provider-cmd-"));
    const commandPath = join(binDir, "agent.cmd");
    await writeFile(commandPath, "@echo off\necho custom\n", "utf8");

    await expect(
      resolveCliCommandForSpawn(
        { command: "agent", args: ["hello"], env: { PATH: binDir } },
        { platform: "win32", execPath: "C:/node/node.exe" },
      ),
    ).resolves.toEqual({ command: "cmd.exe", args: ["/d", "/s", "/c", commandPath, "hello"] });
  });
});
