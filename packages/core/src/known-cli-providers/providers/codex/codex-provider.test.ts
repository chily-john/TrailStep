import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TrailStepFailureError } from "../../../contracts/failures/failure.js";
import type { ProviderWorkingProcessRequest } from "../../registry/provider-registry.types.js";
import { codexProvider } from "./codex-provider.js";

describe("codexProvider.spec", () => {
  it("exposes Codex provider spec without max thinking", () => {
    expect(codexProvider.spec).toMatchObject({
      id: "codex",
      displayName: "Codex",
      model: { supported: true, flag: "-m" },
      thinking: {
        supported: true,
        flag: "-c model_reasoning_effort",
        levels: ["low", "medium", "high", "xhigh"],
      },
      working: {
        command: "codex",
        prompt: { kind: "prompt-file", reference: "at-prefixed-argument" },
        baseArgs: [
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "-o",
          "{{outputFile}}",
          "@{{promptFile}}",
        ],
        output: { style: "provider-output-file" },
      },
      interactive: { supported: true, command: "codex", modelFlag: "--model" },
    });
    expect(codexProvider.spec?.thinking.supported).toBe(true);
    if (codexProvider.spec?.thinking.supported) {
      expect(codexProvider.spec.thinking.levels).toEqual(["low", "medium", "high", "xhigh"]);
    }
  });
});

describe("codexProvider.runWorking", () => {
  it('builds exec --dangerously-bypass-approvals-and-sandbox -m <model> -c model_reasoning_effort="<level>" -o <outputFile> @<promptFile> and never touches envelope parsing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-codex-provider-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hello to Ada.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await codexProvider.runWorking(
      {
        promptFile,
        outputFile,
        cwd,
        model: "gpt-5.5",
        thinking: "medium",
      },
      async (request) => {
        calls.push(request);
        // Simulate what the real `codex exec -o <outputFile>` does: write the
        // final message directly to outputFile, with no envelope wrapper.
        await writeFile(outputFile, '{"greeting":"Hello, Ada!"}', "utf8");
        return { exitCode: 0, stdout: "" };
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "codex",
      cwd,
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        "gpt-5.5",
        "-c",
        'model_reasoning_effort="medium"',
        "-o",
        outputFile,
        `@${promptFile}`,
      ],
    });
    expect(calls[0]?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(calls[0]?.args).toContain("-o");
    expect(calls[0]?.args).toContain(outputFile);

    // runWorking must not have written outputFile itself (the mocked runner did,
    // simulating codex's own -o side effect) and must not wrap/re-parse it.
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("never imports known CLI provider envelope helpers", async () => {
    const source = await readFile(
      join(process.cwd(), "src/known-cli-providers/providers/codex/codex-provider.ts"),
      "utf8",
    );
    expect(source).not.toContain("envelope.js");
    expect(source).not.toContain("extractEnvelopeOutput");
  });

  it("omits -m and -c when model/thinking are not provided, but always includes -o", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-codex-provider-bare-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await codexProvider.runWorking({ promptFile, outputFile, cwd }, async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: "" };
    });

    expect(calls[0]?.args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      outputFile,
      `@${promptFile}`,
    ]);
  });

  it("keeps large prompt content out of argv by passing only a prompt-file reference", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-codex-provider-large-prompt-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    const largePrompt = "x".repeat(120_000);
    await writeFile(promptFile, largePrompt, "utf8");

    const calls: ProviderWorkingProcessRequest[] = [];

    await codexProvider.runWorking({ promptFile, outputFile, cwd }, async (request) => {
      calls.push(request);
      await writeFile(outputFile, '{"ok":true}', "utf8");
      return { exitCode: 0, stdout: "" };
    });

    expect(calls[0]?.args).toContain(`@${promptFile}`);
    expect(calls[0]?.args).not.toContain(largePrompt);
    expect(calls[0]?.args.every((arg) => arg.length < 1000)).toBe(true);
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ ok: true });
  });

  it("throws agent_provider_thinking_unsupported for the 'max' tier (Codex has no max reasoning level)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-codex-provider-max-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      codexProvider.runWorking({ promptFile, outputFile, cwd, thinking: "max" }, async () => ({
        exitCode: 0,
        stdout: "",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_thinking_unsupported" },
    });
  });

  it("throws agent_provider_failed on a non-zero exit code", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-codex-provider-fail-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      codexProvider.runWorking({ promptFile, outputFile, cwd }, async () => ({
        exitCode: 1,
        stdout: "",
      })),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_failed" },
    });
  });

  it("throws agent_provider_spawn_error when the runner rejects", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-codex-provider-spawn-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      codexProvider.runWorking({ promptFile, outputFile, cwd }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toBeInstanceOf(TrailStepFailureError);

    await expect(
      codexProvider.runWorking({ promptFile, outputFile, cwd }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toMatchObject({
      failure: { code: "agent_provider_spawn_error" },
    });
  });
});

describe("codexProvider.runInteractive", () => {
  it("launches with inherited stdio and --model but no dangerous-bypass flag", async () => {
    const calls: unknown[] = [];

    const result = await codexProvider.runInteractive(
      { prompt: "Pair with me on the bug.", cwd: "/tmp/example", model: "gpt-5.5" },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(calls[0]).toMatchObject({
      command: "codex",
      args: ["--model", "gpt-5.5", "Pair with me on the bug."],
      cwd: "/tmp/example",
      shell: false,
      stdio: "inherit",
    });
  });

  it("uses systemPromptFile as an @file prompt reference when available", async () => {
    const calls: unknown[] = [];

    await codexProvider.runInteractive(
      {
        prompt: "Pair with me on the bug.",
        cwd: "/tmp/example",
        model: "gpt-5.5",
        systemPromptFile: "/tmp/whatever/prompt.txt",
      },
      async (request) => {
        calls.push(request);
        return { exitCode: 0 };
      },
    );

    expect((calls[0] as { args: string[] }).args).toEqual([
      "--model",
      "gpt-5.5",
      "@/tmp/whatever/prompt.txt",
    ]);
  });
});
