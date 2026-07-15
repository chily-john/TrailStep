import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StepKitFailureError } from "../../shared/failure.js";
import { codexProvider } from "./codex-provider.js";
import type { ProviderWorkingProcessRequest } from "./provider-adapter.types.js";

describe("codexProvider.runWorking", () => {
  it('builds exec --dangerously-bypass-approvals-and-sandbox -m <model> -c model_reasoning_effort="<level>" -o <outputFile> <prompt> and never touches envelope parsing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-codex-provider-"));
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
        "Say hello to Ada.",
      ],
    });
    expect(calls[0]?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(calls[0]?.args).toContain("-o");
    expect(calls[0]?.args).toContain(outputFile);

    // runWorking must not have written outputFile itself (the mocked runner did,
    // simulating codex's own -o side effect) and must not wrap/re-parse it.
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual({ greeting: "Hello, Ada!" });
  });

  it("never imports providers/envelope.ts", async () => {
    const source = await readFile(
      join(process.cwd(), "src/engine/provider-adapter/codex-provider.ts"),
      "utf8",
    );
    expect(source).not.toContain("envelope.js");
    expect(source).not.toContain("extractEnvelopeOutput");
  });

  it("omits -m and -c when model/thinking are not provided, but always includes -o", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-codex-provider-bare-"));
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
      "Say hi.",
    ]);
  });

  it("throws agent_provider_thinking_unsupported for the 'max' tier (Codex has no max reasoning level)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-codex-provider-max-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-codex-provider-fail-"));
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
    const cwd = await mkdtemp(join(tmpdir(), "stepkit-core-codex-provider-spawn-"));
    const promptFile = join(cwd, "prompt.md");
    const outputFile = join(cwd, "output.json");
    await writeFile(promptFile, "Say hi.", "utf8");

    await expect(
      codexProvider.runWorking({ promptFile, outputFile, cwd }, async () => {
        throw new Error("ENOENT");
      }),
    ).rejects.toBeInstanceOf(StepKitFailureError);

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
});
