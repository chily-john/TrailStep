import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverPiModelOverrides, parsePiModelDiscoveryOutput } from "./pi-model-discovery.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe("parsePiModelDiscoveryOutput", () => {
  it("parses pi --list-models table output", () => {
    const output = ["provider   model", "anthropic  claude-sonnet-4-5", "openai     gpt-5"].join(
      "\n",
    );

    expect(parsePiModelDiscoveryOutput(output)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
  });

  it("resolves npm .cmd shims to node before model discovery on Windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-pi-discovery-shim-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "pi.cmd"),
      [
        "@ECHO off",
        "SETLOCAL",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-pi\\dist\\cli.js" %*',
      ].join("\n"),
      "utf8",
    );
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.PATH = binDir;

    const requests: Array<{ command: string; args: readonly string[] }> = [];
    const models = await discoverPiModelOverrides({
      cwd: dir,
      packageCommandRunner: async (request) => {
        requests.push({ command: request.command, args: request.args });
        return {
          exitCode: 0,
          stdout: ["provider   model", "anthropic  claude-sonnet-4-5"].join("\n"),
          stderr: "",
        };
      },
    });

    expect(models).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toBe(process.execPath);
    expect(requests[0]?.args[0]).toBe(join(binDir, "node_modules/fake-pi/dist/cli.js"));
    expect(requests[0]?.args.slice(1)).toEqual(["--list-models"]);
  });
});
