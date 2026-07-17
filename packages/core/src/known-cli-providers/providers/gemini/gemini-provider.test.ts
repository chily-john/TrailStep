import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { ProviderWorkingProcessRequest } from "../../registry/provider-registry.types.js";
import { geminiProvider } from "./gemini-provider.js";

// NOTE: the real `gemini` CLI is not installed in this environment. Every
// case in this file exercises `geminiProvider` against an injected fake
// runner only (structural verification of argv-building and envelope
// extraction), never a live process. A real `gemini --version` +
// end-to-end smoke test remains a required follow-up before this adapter is
// trusted in production — see `mock-local-test/README.md` and
// `docs/architecture.md`.
describe("geminiProvider.runWorking", () => {
  it("builds -p <prompt> --yolo -m <model> --output-format json and writes outputFile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-gemini-provider-"));
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
      args: [
        "-p",
        "Say hello to Ada.",
        "--yolo",
        "-m",
        "gemini-2.5-pro",
        "--output-format",
        "json",
      ],
    });

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("omits -m when model is not provided, and thinking never appears in argv (documented no-op)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-gemini-provider-bare-"));
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

    expect(calls[0]?.args).toEqual(["-p", "Say hi.", "--yolo", "--output-format", "json"]);
  });

  it("throws agent_provider_failed on a non-zero exit code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-gemini-provider-fail-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-gemini-provider-badjson-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      geminiProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toBeInstanceOf(StepKitFailureError);

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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-gemini-provider-spawn-"));
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
});
