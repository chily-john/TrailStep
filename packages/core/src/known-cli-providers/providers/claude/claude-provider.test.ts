import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import type { ProviderWorkingProcessRequest } from "../../registry/provider-registry.types.js";
import { claudeProvider } from "./claude-provider.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("claudeProvider.spec", () => {
  it("exposes a standardized Claude provider spec", () => {
    expect(claudeProvider.spec).toMatchObject({
      id: "claude",
      displayName: "Claude",
      model: { supported: true, flag: "--model" },
      thinking: {
        supported: true,
        flag: "--effort",
        levels: ["low", "medium", "high", "xhigh", "max"],
      },
      working: {
        command: "claude",
        prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
        baseArgs: [
          "-p",
          "@{{promptFile}}",
          "--output-format",
          "json",
          "--dangerously-skip-permissions",
        ],
        output: {
          style: "stdout-json-envelope",
          parsing: { resultField: "result" },
        },
      },
      interactive: {
        supported: true,
        command: "claude",
        requiresSystemPromptFile: true,
        systemPromptFileFlag: "--append-system-prompt-file",
      },
    });
  });
});

describe("claudeProvider.runWorking", () => {
  it("builds -p @<promptFile> --output-format json --dangerously-skip-permissions --model <model> --effort <level> and writes outputFile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-"));
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
        `@${promptFile}`,
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--model",
        "sonnet",
        "--effort",
        "medium",
      ],
    });
    expect(calls[0]?.args).not.toContain("Say hello to Ada.");
    expect(calls[0]?.stdin).toBeUndefined();

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("omits --model and --effort when not provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-bare-"));
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
      `@${promptFile}`,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
    expect(calls[0]?.stdin).toBeUndefined();
  });

  it("passes a prompt-file reference instead of prompt content, even for a 100KB+ prompt (Windows CreateProcess argv-length regression check)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-large-prompt-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    const largePrompt = "x".repeat(120_000);
    await writeFile(promptFile, largePrompt, "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await claudeProvider.runWorking({ promptFile, outputFile, cwd }, async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: JSON.stringify({ result: '{"ok":true}' }) };
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdin).toBeUndefined();
    expect(calls[0]?.args).toContain(`@${promptFile}`);
    expect(calls[0]?.args).not.toContain(largePrompt);
    expect(calls[0]?.args.every((arg) => arg.length < 1000)).toBe(true);
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ ok: true });
  });

  it("the default runner (spawnClaudeCapturingStdout) ignores stdin when the prompt is a file reference", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-stdin-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
    child.stdout = new EventEmitter();

    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const runPromise = claudeProvider.runWorking({ promptFile, outputFile, cwd });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from(JSON.stringify({ result: '{"ok":true}' })));
    child.emit("close", 0);
    await runPromise;

    expect(spawn).toHaveBeenCalledWith(
      "claude",
      ["-p", `@${promptFile}`, "--output-format", "json", "--dangerously-skip-permissions"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "inherit"] }),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("writes usage.json after successful output extraction", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-usage-"));
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
    const failedCwd = await mkdtemp(
      join(tmpdir(), "trailstep-core-claude-provider-no-usage-fail-"),
    );
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
      join(tmpdir(), "trailstep-core-claude-provider-no-usage-invalid-"),
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
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-fail-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-badjson-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toBeInstanceOf(TrailStepFailureError);

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_output_invalid" },
    });
  });

  it("surfaces sessionId and rawResultText in the failure details when the envelope parses but its result field isn't usable JSON, so a repair attempt is possible", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-badjson-session-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "session-abc",
          result: "Here is some prose instead of JSON.",
        }),
      })),
    ).rejects.toMatchObject({
      failure: {
        code: "agent_provider_output_invalid",
        details: {
          sessionId: "session-abc",
          rawResultText: "Here is some prose instead of JSON.",
        },
      },
    });
  });

  it("omits sessionId from failure details when stdout has no parsable envelope at all (repair is not attempted)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-badjson-nosession-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      claudeProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 0,
        stdout: "not usable",
      })),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof TrailStepFailureError &&
        !Object.hasOwn(error.failure.details as object, "sessionId")
      );
    });
  });

  it("throws agent_provider_spawn_error when the runner rejects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-spawn-"));
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

  it("writes a plain-text result verbatim, with no JSON parsing, when captureMode is raw-text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-rawtext-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.md");
    await writeFile(promptFile, "Write a feature doc.", "utf8");

    const documentText = "# Feature Doc\n\nThis is plain markdown, not JSON.";

    await claudeProvider.runWorking(
      { promptFile, outputFile, cwd, captureMode: "raw-text" },
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", is_error: false, result: documentText }),
      }),
    );

    expect(await readFile(outputFile, "utf8")).toEqual(documentText);
  });

  it("still JSON-extracts when captureMode is json (or omitted), regression check", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-provider-jsonmode-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await claudeProvider.runWorking(
      { promptFile, outputFile, cwd, captureMode: "json" },
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ result: '{"greeting":"Hi!"}' }),
      }),
    );

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hi!" });
  });
});

describe("claudeProvider.repairOutput", () => {
  it("builds --resume <sessionId> -p --output-format json --dangerously-skip-permissions (plus model/effort), sends a reformat-only prompt via stdin, and accepts a well-formed reply", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-repair-"));
    const outputFile = join(cwd, "output.json");

    const calls: ProviderWorkingProcessRequest[] = [];

    await claudeProvider.repairOutput?.(
      {
        sessionId: "session-123",
        rawResultText: "Sorry, here's some prose instead of JSON.",
        outputFile,
        cwd,
        model: "sonnet",
        thinking: "medium",
        outputSchema: {
          type: "object",
          properties: { greeting: { type: "string" } },
          required: ["greeting"],
        },
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
        "--resume",
        "session-123",
        "-p",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--model",
        "sonnet",
        "--effort",
        "medium",
      ],
    });
    expect(calls[0]?.stdin).toContain("Sorry, here's some prose instead of JSON.");
    expect(calls[0]?.stdin).toContain("Do not redo the task");
    expect(calls[0]?.stdin).toContain('"greeting"');

    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("omits --model and --effort when not provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-repair-bare-"));
    const outputFile = join(cwd, "output.json");

    const calls: ProviderWorkingProcessRequest[] = [];

    await claudeProvider.repairOutput?.(
      {
        sessionId: "session-bare",
        rawResultText: "prose",
        outputFile,
        cwd,
        outputSchema: { type: "object" },
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0, stdout: JSON.stringify({ result: '{"ok":true}' }) };
      },
    );

    expect(calls[0]?.args).toEqual([
      "--resume",
      "session-bare",
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  it("throws agent_provider_output_invalid when the repair reply is itself malformed, without retrying again", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-claude-repair-stillbad-"));
    const outputFile = join(cwd, "output.json");

    const calls: ProviderWorkingProcessRequest[] = [];

    await expect(
      claudeProvider.repairOutput?.(
        {
          sessionId: "session-stillbad",
          rawResultText: "prose",
          outputFile,
          cwd,
          outputSchema: { type: "object" },
        },
        async (request) => {
          calls.push(request);
          return { exitCode: 0, stdout: "still prose, not JSON" };
        },
      ),
    ).rejects.toMatchObject({ failure: { code: "agent_provider_output_invalid" } });

    expect(calls).toHaveLength(1);
  });
});

describe("claudeProvider.runInteractive", () => {
  it("launches with --dangerously-skip-permissions by default", async () => {
    const calls: unknown[] = [];

    const result = await claudeProvider.runInteractive(
      {
        prompt: "Pair with me on the bug.",
        cwd: "/tmp/example",
        model: "opus",
        systemPromptFile: "/tmp/example/prompt.txt",
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(calls[0]).toMatchObject({
      command: "claude",
      args: [
        "--model",
        "opus",
        "--dangerously-skip-permissions",
        "--append-system-prompt-file",
        "/tmp/example/prompt.txt",
      ],
      cwd: "/tmp/example",
      shell: false,
      stdio: "inherit",
    });
  });

  it("omits --dangerously-skip-permissions when permissionMode is prompt", async () => {
    const calls: unknown[] = [];

    await claudeProvider.runInteractive(
      {
        prompt: "Pair with me on the bug.",
        cwd: "/tmp/example",
        model: "opus",
        permissionMode: "prompt",
        systemPromptFile: "/tmp/example/prompt.txt",
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect((calls[0] as { args: string[] }).args.includes("--dangerously-skip-permissions")).toBe(
      false,
    );
  });

  it("throws agent_provider_invalid_request when systemPromptFile is missing", async () => {
    await expect(
      claudeProvider.runInteractive(
        { prompt: "Pair with me on the bug.", cwd: "/tmp/example", model: "opus" },
        async () => ({ exitCode: 0 }),
      ),
    ).rejects.toMatchObject({ failure: { code: "agent_provider_invalid_request" } });
  });

  it("pushes --append-system-prompt-file with no positional prompt when systemPromptFile is set", async () => {
    const calls: unknown[] = [];

    await claudeProvider.runInteractive(
      {
        prompt: "full combined text",
        cwd: "/tmp/example",
        model: "opus",
        systemPromptFile: "/tmp/example/prompt.txt",
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect((calls[0] as { args: string[] }).args).toEqual([
      "--model",
      "opus",
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      "/tmp/example/prompt.txt",
    ]);
    expect((calls[0] as { args: string[] }).args.includes("full combined text")).toBe(false);
  });
});
