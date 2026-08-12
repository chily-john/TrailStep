import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import type { ProviderWorkingProcessRequest } from "../../registry/provider-registry.types.js";
import { geminiProvider } from "./gemini-provider.js";

// NOTE: the real `gemini` CLI is not installed in this environment. Every
// case in this file exercises `geminiProvider` against an injected fake
// runner only (structural verification of argv-building and envelope
// extraction), never a live process. A real `gemini --version` +
// end-to-end smoke test remains required before this adapter is trusted in
// production.
describe("geminiProvider.spec", () => {
  it("exposes Gemini provider spec with thinking unavailable", () => {
    expect(geminiProvider.spec).toMatchObject({
      id: "gemini",
      displayName: "Gemini",
      model: { supported: true, flag: "-m" },
      thinking: { supported: false },
      working: {
        command: "gemini",
        prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
        baseArgs: ["-p", "@{{promptFile}}", "--yolo", "--output-format", "json"],
        output: {
          style: "stdout-json-envelope",
          parsing: { resultField: "response" },
        },
      },
      interactive: { supported: true, command: "gemini", modelFlag: "-m" },
    });
    expect(geminiProvider.spec?.thinking).toEqual({ supported: false });
  });
});

describe("geminiProvider.runWorking", () => {
  it("builds -p @<promptFile> --yolo -m <model> --output-format json and writes outputFile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hello to Ada.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    // Synthetic stdout shaped like the Gemini CLI's documented
    // `--output-format json` envelope: a flat "response" string field plus a
    // "stats" object, not empirically confirmed against a real invocation.
    await geminiProvider.runWorking(
      {
        promptFile,
        outputFile,
        cwd,
        model: "gemini-2.5-pro",
        thinking: "medium",
      },
      async (request) => {
        calls.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: '{"greeting":"Hello, Ada!"}',
            stats: { models: {}, tools: {} },
          }),
        };
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "gemini",
      cwd,
      args: ["-p", `@${promptFile}`, "--yolo", "-m", "gemini-2.5-pro", "--output-format", "json"],
    });

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("omits -m when model is not provided, and thinking never appears in argv (documented no-op)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-bare-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await geminiProvider.runWorking(
      { promptFile, outputFile, cwd, thinking: "high" },
      async (request) => {
        calls.push(request);
        return { exitCode: 0, stdout: JSON.stringify({ response: '{"greeting":"Hi!"}' }) };
      },
    );

    expect(calls[0]?.args).toEqual(["-p", `@${promptFile}`, "--yolo", "--output-format", "json"]);
  });

  it("keeps large prompt content out of argv by passing only a prompt-file reference", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-large-prompt-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    const largePrompt = "x".repeat(120_000);
    await writeFile(promptFile, largePrompt, "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await geminiProvider.runWorking({ promptFile, outputFile, cwd }, async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: JSON.stringify({ response: '{"ok":true}' }) };
    });

    expect(calls[0]?.args).toContain(`@${promptFile}`);
    expect(calls[0]?.args).not.toContain(largePrompt);
    expect(calls[0]?.args.every((arg) => arg.length < 1000)).toBe(true);
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ ok: true });
  });

  it("throws agent_provider_failed on a non-zero exit code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-fail-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      geminiProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 1,
        stdout: "",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_failed" },
    });
  });

  it("throws agent_provider_output_invalid when stdout has no usable JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-badjson-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      geminiProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toBeInstanceOf(TrailStepFailureError);

    await expect(
      geminiProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_output_invalid" },
    });
  });

  it("throws agent_provider_spawn_error when the runner rejects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-spawn-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      geminiProvider.runWorking({ promptFile, outputFile, cwd }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_spawn_error" },
    });
  });

  it("writes a plain-text response verbatim, with no JSON parsing, when captureMode is raw-text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-rawtext-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.md");
    await writeFile(promptFile, "Write a feature doc.", "utf8");

    const documentText = "# Feature Doc\n\nThis is plain markdown, not JSON.";

    await geminiProvider.runWorking(
      { promptFile, outputFile, cwd, captureMode: "raw-text" },
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ response: documentText, stats: {} }),
      }),
    );

    expect(await readFile(outputFile, "utf8")).toEqual(documentText);
  });

  it("still JSON-extracts when captureMode is json (or omitted), regression check", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-gemini-provider-jsonmode-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await geminiProvider.runWorking(
      { promptFile, outputFile, cwd, captureMode: "json" },
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ response: '{"greeting":"Hi!"}' }),
      }),
    );

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hi!" });
  });
});

describe("geminiProvider.runInteractive", () => {
  it("launches with inherited stdio and -m but no dangerous/auto-accept flag", async () => {
    const calls: unknown[] = [];

    const result = await geminiProvider.runInteractive(
      { prompt: "Pair with me on the bug.", cwd: "/tmp/example", model: "gemini-2.5-pro" },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(calls[0]).toMatchObject({
      command: "gemini",
      args: ["-m", "gemini-2.5-pro", "Pair with me on the bug."],
      cwd: "/tmp/example",
      shell: false,
      stdio: "inherit",
    });
  });

  it("uses systemPromptFile as an @file prompt reference and ignores permissionMode", async () => {
    const calls: unknown[] = [];

    await geminiProvider.runInteractive(
      {
        prompt: "Pair with me on the bug.",
        cwd: "/tmp/example",
        model: "gemini-2.5-pro",
        permissionMode: "prompt",
        systemPromptFile: "/tmp/whatever/prompt.txt",
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect((calls[0] as { args: string[] }).args).toEqual([
      "-m",
      "gemini-2.5-pro",
      "@/tmp/whatever/prompt.txt",
    ]);
  });
});
