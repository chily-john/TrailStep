import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TrailStepConfig } from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import type { WorkingAgentProcessRequest } from "../../../../runtime/run-workflow/run-workflow.types.js";
import { runManifestWorkingProvider } from "./run-manifest-working-provider.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

function stubWindowsPlatform(): void {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}

async function writeNpmShim(binDir: string): Promise<void> {
  await writeFile(
    join(binDir, "pi.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-pi\\dist\\cli.js" %*',
    ].join("\n"),
    "utf8",
  );
}

function jsonOutputSchema(): AgentStepRequestConfig<PlainObject, { answer: string }>["output"] {
  return {
    validate: (value: unknown): value is { answer: string } =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { answer?: unknown }).answer === "string",
    diagnostics: () => [],
    assert: (value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { answer?: unknown }).answer !== "string"
      ) {
        throw new Error("expected { answer: string }");
      }
      return value as { answer: string };
    },
    jsonSchema: { type: "object" },
    captureMode: "json",
  };
}

describe("runManifestWorkingProvider Windows shim resolution", () => {
  it("resolves npm .cmd shims to node before spawning with shell:false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-manifest-shim-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeNpmShim(binDir);
    stubWindowsPlatform();
    process.env.PATH = binDir;

    const stepDir = join(dir, "steps", "0001-review");
    await mkdir(stepDir, { recursive: true });
    const promptFile = join(stepDir, "prompt.md");
    const outputFile = join(stepDir, "output.json");
    await writeFile(promptFile, "Review this.", "utf8");

    const config = {
      providers: {
        pi: {
          source: { type: "local-manifest", path: "pi.json" },
          manifest: {
            schemaVersion: 1,
            id: "pi",
            displayName: "Pi",
            working: {
              supported: true,
              command: "pi",
              args: ["-p", "--mode", "json", "@{{promptFile}}"],
              output: { style: "provider-output-file" },
            },
            interactive: { supported: true, command: "pi" },
            model: { supported: true },
            thinking: { supported: true },
          },
        },
      },
    } as unknown as TrailStepConfig;

    const requests: WorkingAgentProcessRequest[] = [];
    const output = await runManifestWorkingProvider({
      config,
      step: {
        id: "review",
        output: jsonOutputSchema(),
        prompt: "Review this.",
        requirements: { size: "medium" },
      },
      role: { size: "medium" },
      cwd: dir,
      target: { provider: "pi" },
      files: { stepDir, promptFile, outputFile, usageFile: join(stepDir, "usage.json") },
      runner: async (request) => {
        requests.push(request);
        await writeFile(outputFile, JSON.stringify({ answer: "looks good" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(output).toEqual({ answer: "looks good" });
    expect(requests).toHaveLength(1);
    // Shim resolved to the Node entrypoint; shell stays false.
    expect(requests[0]?.command).toBe(process.execPath);
    expect(requests[0]?.args[0]).toBe(join(binDir, "node_modules/fake-pi/dist/cli.js"));
    expect(requests[0]?.args.slice(1)).toEqual(["-p", "--mode", "json", `@${promptFile}`]);
    expect(requests[0]?.shell).toBe(false);
  });
});
