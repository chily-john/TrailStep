import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StepKitFailureError } from "../../shared/failure.js";
import { claudeProvider } from "./claude-provider.js";
import type { ProviderWorkingProcessRequest } from "./provider-adapter.types.js";

describe("claudeProvider.runWorking", () => {
  it("builds -p --output-format json --dangerously-skip-permissions --model <model> --effort <level> <prompt> and writes outputFile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-claude-provider-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hello to Ada.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await claudeProvider.runWorking(
      {
        promptFile,
        outputFile,
        cwd,
        model: "sonnet",
        thinking: "medium",
      },
      async (request) => {
        calls.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: '{"greeting":"Hello, Ada!"}' }),
        };
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "claude",
      cwd,
      args: [
        "-p",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--model",
        "sonnet",
        "--effort",
        "medium",
        "Say hello to Ada.",
      ],
    });

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("omits --model and --effort when not provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-claude-provider-bare-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await claudeProvider.runWorking({ promptFile, outputFile, cwd }, async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: JSON.stringify({ result: '{"greeting":"Hi!"}' }) };
    });

    expect(calls[0]?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "Say hi.",
    ]);
  });

  it("writes usage.json after successful output extraction", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-claude-provider-usage-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    const usageFile = join(cwd, "usage.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await claudeProvider.runWorking({ promptFile, outputFile, usageFile, cwd }, async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        result: '{"greeting":"Hi!"}',
        usage: { input_tokens: 1, output_tokens: 2 },
        total_cost_usd: 0.01,
        duration_ms: 123,
        num_turns: 1,
        session_id: "session-usage",
      }),
    }));

    const usage = JSON.parse(await readFile(usageFile, "utf8"));
    expect(usage).toMatchObject({
      usage: { inputTokens: 1, outputTokens: 2 },
      costUsd: 0.01,
      durationMs: 123,
      turns: 1,
      sessionId: "session-usage",
    });
    expect(usage.harnessDurationMs).toEqual(expect.any(Number));
  });

  it("does not write usage.json when Claude exits nonzero or output parsing fails", async () => {
    const failedCwd = await mkdtemp(join(tmpdir(), "stepkit-core-claude-provider-no-usage-fail-"));
    const failedPromptFile = join(failedCwd, "prompt.md");
    const failedOutputFile = join(failedCwd, "output.json");
    const failedUsageFile = join(failedCwd, "usage.json");
    await writeFile(failedPromptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking(
        {
          promptFile: failedPromptFile,
          outputFile: failedOutputFile,
          usageFile: failedUsageFile,
          cwd: failedCwd,
        },
        async () => ({ exitCode: 1, stdout: "" }),
      ),
    ).rejects.toMatchObject({ failure: { code: "agent_provider_failed" } });
    await expect(access(failedUsageFile)).rejects.toThrow();

    const invalidCwd = await mkdtemp(
      join(tmpdir(), "stepkit-core-claude-provider-no-usage-invalid-"),
    );
    const invalidPromptFile = join(invalidCwd, "prompt.md");
    const invalidOutputFile = join(invalidCwd, "output.json");
    const invalidUsageFile = join(invalidCwd, "usage.json");
    await writeFile(invalidPromptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking(
        {
          promptFile: invalidPromptFile,
          outputFile: invalidOutputFile,
          usageFile: invalidUsageFile,
          cwd: invalidCwd,
        },
        async () => ({ exitCode: 0, stdout: "not usable" }),
      ),
    ).rejects.toMatchObject({ failure: { code: "agent_provider_output_invalid" } });
    await expect(access(invalidUsageFile)).rejects.toThrow();
  });

  it("throws agent_provider_failed on a non-zero exit code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-claude-provider-fail-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 1,
        stdout: "",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_failed" },
    });
  });

  it("throws agent_provider_output_invalid when stdout has no usable JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-claude-provider-badjson-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toBeInstanceOf(StepKitFailureError);

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_output_invalid" },
    });
  });

  it("throws agent_provider_spawn_error when the runner rejects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-claude-provider-spawn-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_spawn_error" },
    });
  });
});

describe("claudeProvider.runInteractive", () => {
  it("launches with inherited stdio and --model but no dangerous-permissions flag", async () => {
    const calls: unknown[] = [];

    const result = await claudeProvider.runInteractive(
      { prompt: "Pair with me on the bug.", cwd: "/tmp/example", model: "opus" },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(calls[0]).toMatchObject({
      command: "claude",
      args: ["--model", "opus", "Pair with me on the bug."],
      cwd: "/tmp/example",
      shell: false,
      stdio: "inherit",
    });
  });
});
