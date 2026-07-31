import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StepKitFailureError } from "../../../contracts/failures/failure.js";
import type { ProviderWorkingProcessRequest } from "../../registry/provider-registry.types.js";
import { createPiJsonStreamStdoutCollector, piProvider } from "./pi-provider.js";

describe("piProvider.runWorking", () => {
  it("builds -p --model <pattern> --thinking <level> @<promptFile> --mode json and writes outputFile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hello to Ada.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    // Simulates the real, empirically observed `pi --mode json` shape: a
    // JSON-lines transcript whose last usable "message" field is a
    // message-object with a content-block array, not a flat string.
    const stdout = [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"greeting":"Hello, Ada!"}' }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [] }),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n");

    await piProvider.runWorking(
      {
        promptFile,
        outputFile,
        cwd,
        model: "openai-codex/gpt-5.5",
        thinking: "high",
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0, stdout };
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "pi",
      cwd,
      args: [
        "-p",
        "--model",
        "openai-codex/gpt-5.5",
        "--thinking",
        "high",
        `@${promptFile}`,
        "--mode",
        "json",
      ],
    });

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("concatenates multiple text blocks and skips a leading thinking block", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-thinking-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hello to Ada.", "utf8");

    const stdout = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: '{"greeting"' },
          { type: "text", text: ':"Hello, Ada!"}' },
        ],
      },
    });

    await piProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
      exitCode: 0,
      stdout,
    }));

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("omits --model and --thinking when not provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-bare-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await piProvider.runWorking({ promptFile, outputFile, cwd }, async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "turn_end",
          message: { role: "assistant", content: [{ type: "text", text: '{"greeting":"Hi!"}' }] },
        }),
      };
    });

    expect(calls[0]?.args).toEqual(["-p", `@${promptFile}`, "--mode", "json"]);
  });

  it("keeps large prompt content out of argv by passing only a prompt-file reference", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-large-prompt-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    const largePrompt = "x".repeat(120_000);
    await writeFile(promptFile, largePrompt, "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await piProvider.runWorking({ promptFile, outputFile, cwd }, async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: "turn_end",
          message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }] },
        }),
      };
    });

    expect(calls[0]?.args).toContain(`@${promptFile}`);
    expect(calls[0]?.args).not.toContain(largePrompt);
    expect(calls[0]?.args.every((arg) => arg.length < 1000)).toBe(true);
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ ok: true });
  });

  it("throws agent_provider_failed on a non-zero exit code with no usable result", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-fail-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      piProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 1,
        stdout: "",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_failed" },
    });
  });

  it("accepts a usable final JSON message even when Pi exits non-zero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-nonzero-result-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Implement a story.", "utf8");

    const stdout = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({ blocked: false, summary: "Ran a red test before green." }),
          },
        ],
      },
    });

    await piProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
      exitCode: 1,
      stdout,
    }));

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({
      blocked: false,
      summary: "Ran a red test before green.",
    });
  });

  it("throws agent_provider_output_invalid when stdout has no usable JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-badjson-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      piProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toBeInstanceOf(StepKitFailureError);

    await expect(
      piProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_output_invalid" },
    });
  });

  it("throws agent_provider_spawn_error when the runner rejects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-spawn-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      piProvider.runWorking({ promptFile, outputFile, cwd }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_spawn_error" },
    });
  });

  it("writes a plain-text message verbatim, with no JSON parsing, when captureMode is raw-text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-rawtext-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.md");
    await writeFile(promptFile, "Write a feature doc.", "utf8");

    const documentText = "# Feature Doc\n\nThis is plain markdown, not JSON.";
    const stdout = JSON.stringify({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: documentText }] },
    });

    await piProvider.runWorking(
      { promptFile, outputFile, cwd, captureMode: "raw-text" },
      async () => ({ exitCode: 0, stdout }),
    );

    expect(await readFile(outputFile, "utf8")).toEqual(documentText);
  });

  it("still JSON-extracts when captureMode is json (or omitted), regression check", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-pi-provider-jsonmode-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await piProvider.runWorking({ promptFile, outputFile, cwd, captureMode: "json" }, async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: '{"greeting":"Hi!"}' }] },
      }),
    }));

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hi!" });
  });
});

describe("createPiJsonStreamStdoutCollector", () => {
  it("keeps only the latest usable Pi JSON result line from streaming transcripts", () => {
    const collector = createPiJsonStreamStdoutCollector();
    const finalLine = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '{"ok":true}' }],
      },
    });

    for (let index = 0; index < 500; index += 1) {
      collector.append(
        Buffer.from(
          `${JSON.stringify({
            type: "message_update",
            message: {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify({ index }) }],
            },
            ignoredTranscriptPayload: "x".repeat(5_000),
          })}\n`,
        ),
      );
    }

    collector.append(Buffer.from(`${finalLine}\n${JSON.stringify({ type: "agent_settled" })}\n`));

    const compacted = collector.finish();
    expect(compacted).toEqual(finalLine);
    expect(compacted).not.toContain("ignoredTranscriptPayload");
  });
});

describe("piProvider.runInteractive", () => {
  it("launches with inherited stdio and --model but no dangerous flag", async () => {
    const calls: unknown[] = [];

    const result = await piProvider.runInteractive(
      { prompt: "Pair with me on the bug.", cwd: "/tmp/example", model: "openai-codex/gpt-5.5" },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(calls[0]).toMatchObject({
      command: "pi",
      args: ["--model", "openai-codex/gpt-5.5", "Pair with me on the bug."],
      cwd: "/tmp/example",
      shell: false,
      stdio: "inherit",
    });
  });

  it("uses systemPromptFile as an @file prompt reference and ignores permissionMode", async () => {
    const calls: unknown[] = [];

    await piProvider.runInteractive(
      {
        prompt: "Pair with me on the bug.",
        cwd: "/tmp/example",
        model: "openai-codex/gpt-5.5",
        permissionMode: "prompt",
        systemPromptFile: "/tmp/whatever/prompt.txt",
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect((calls[0] as { args: string[] }).args).toEqual([
      "--model",
      "openai-codex/gpt-5.5",
      "@/tmp/whatever/prompt.txt",
    ]);
  });
});
