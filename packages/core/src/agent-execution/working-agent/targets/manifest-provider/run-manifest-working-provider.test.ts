import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TrailStepConfig } from "../../../../agent-targeting/targeting.types.js";
import type { AgentStepRequestConfig } from "../../../../authoring/step/agent-step.types.js";
import { TrailStepFailureError } from "../../../../contracts/failures/failure.js";
import type { PlainObject } from "../../../../contracts/shapes/shape.types.js";
import type {
  WorkingAgentProcessRequest,
  WorkingAgentProcessResult,
} from "../../../../runtime/run-workflow/run-workflow.types.js";
import type { WorkingAgentFiles } from "../../artifacts/resolve-step-agent-files.js";
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
      files: {
        stepDir,
        promptFile,
        outputFile,
        usageFile: join(stepDir, "usage.json"),
        workFile: join(stepDir, "work.txt"),
        repairPromptFile: join(stepDir, "repair-prompt.md"),
      },
      renderedPrompt: "Review this.",
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

function twoPhaseManifestConfig(working: Record<string, unknown>): TrailStepConfig {
  return {
    providers: {
      worker: {
        source: { type: "local-manifest", path: "worker.trailstep-provider.json" },
        manifest: {
          schemaVersion: 1,
          id: "worker",
          displayName: "Worker",
          working,
          interactive: { supported: false, reason: "No interactive mode" },
          model: { supported: true },
          thinking: { supported: true },
        },
      },
    },
  } as unknown as TrailStepConfig;
}

async function createTwoPhaseFiles(dir: string): Promise<WorkingAgentFiles> {
  const stepDir = join(dir, "steps", "0001-review");
  await mkdir(stepDir, { recursive: true });
  const promptFile = join(stepDir, "prompt.md");
  await writeFile(promptFile, "Front-loaded prompt.", "utf8");
  return {
    stepDir,
    promptFile,
    outputFile: join(stepDir, "output.json"),
    usageFile: join(stepDir, "usage.json"),
    workFile: join(stepDir, "work.txt"),
    repairPromptFile: join(stepDir, "repair-prompt.md"),
  };
}

function twoPhaseStep(): AgentStepRequestConfig<PlainObject, { answer: string }> {
  return {
    id: "review",
    output: jsonOutputSchema(),
    prompt: "Review this.",
    requirements: { size: "medium" },
  };
}

function envelopeFollowUpWorking(): Record<string, unknown> {
  return {
    supported: true,
    command: "worker",
    args: ["--prompt-file", "{{promptFile}}"],
    output: { style: "stdout-json-envelope", parsing: { resultField: "result" } },
    followUp: {
      supported: true,
      sessionIdFlag: "--session",
      resumeArgs: [
        "--resume",
        "{{sessionId}}",
        "--prompt-file",
        "{{promptFile}}",
        "--output-file",
        "{{outputFile}}",
      ],
    },
  };
}

function outputFileFollowUpWorking(followUp: Record<string, unknown>): Record<string, unknown> {
  return {
    supported: true,
    command: "worker",
    args: ["--prompt-file", "{{promptFile}}", "--output-file", "{{outputFile}}"],
    output: { style: "provider-output-file" },
    followUp,
  };
}

describe("runManifestWorkingProvider two-phase follow-up", () => {
  it("runs Phase 1 and a pinned Phase 2, capturing raw work output and the format result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-two-phase-envelope-"));
    const files = await createTwoPhaseFiles(dir);
    const requests: WorkingAgentProcessRequest[] = [];

    const output = await runManifestWorkingProvider({
      config: twoPhaseManifestConfig(envelopeFollowUpWorking()),
      step: twoPhaseStep(),
      role: { size: "medium" },
      cwd: dir,
      target: { provider: "worker" },
      files,
      renderedPrompt: "Do the review.",
      runner: async (request): Promise<WorkingAgentProcessResult> => {
        requests.push(request);
        if (requests.length === 1) {
          return { exitCode: 0, stdout: "Raw work report: reviewed everything." };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: JSON.stringify({ answer: "formatted" }) }),
        };
      },
    });

    expect(output).toEqual({ answer: "formatted" });
    expect(requests).toHaveLength(2);

    // Phase 1: work-only prompt overwrite, raw work capture, session pinning.
    const phase1Args = requests[0]?.args ?? [];
    const sessionId = phase1Args[phase1Args.length - 1];
    expect(phase1Args).toEqual(["--prompt-file", files.promptFile, "--session", sessionId]);
    expect(requests[0]?.stdio).toBe("pipe");
    expect(requests[0]?.promptFile).toBe(files.promptFile);
    const workPrompt = await readFile(files.promptFile, "utf8");
    expect(workPrompt).toContain("# TrailStep working-agent task");
    expect(workPrompt).toContain("Do the review.");
    await expect(readFile(files.workFile, "utf8")).resolves.toBe(
      "Raw work report: reviewed everything.",
    );

    // Phase 2: pinned resume in the same session, repair prompt, final output.
    expect(requests[1]?.args).toEqual([
      "--resume",
      sessionId,
      "--prompt-file",
      files.repairPromptFile,
      "--output-file",
      files.outputFile,
    ]);
    expect(requests[1]?.stdio).toBe("pipe");
    const repairPrompt = await readFile(files.repairPromptFile, "utf8");
    expect(repairPrompt).toContain("# TrailStep format follow-up");
    expect(repairPrompt).toContain('"type": "object"');

    const usage = JSON.parse(await readFile(files.usageFile, "utf8")) as Record<string, unknown>;
    expect(usage).toEqual({ sessionId, provider: "worker", phases: 2 });
  });

  it("lets the provider write the work file directly for provider-output-file style", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-two-phase-output-file-"));
    const files = await createTwoPhaseFiles(dir);
    const requests: WorkingAgentProcessRequest[] = [];

    const output = await runManifestWorkingProvider({
      config: twoPhaseManifestConfig(
        outputFileFollowUpWorking({
          supported: true,
          sessionIdFlag: "--session",
          resumeArgs: [
            "--resume",
            "{{sessionId}}",
            "--prompt-file",
            "{{promptFile}}",
            "--output-file",
            "{{outputFile}}",
          ],
        }),
      ),
      step: twoPhaseStep(),
      role: { size: "medium" },
      cwd: dir,
      target: { provider: "worker" },
      files,
      renderedPrompt: "Do the review.",
      runner: async (request): Promise<WorkingAgentProcessResult> => {
        requests.push(request);
        if (requests.length === 1) {
          await writeFile(request.outputFile, "work via -o", "utf8");
          return { exitCode: 0 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "via -o final" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(output).toEqual({ answer: "via -o final" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.stdio).toBe("inherit");
    expect(requests[1]?.stdio).toBe("inherit");
    expect(requests[0]?.outputFile).toBe(files.workFile);
    expect(requests[1]?.outputFile).toBe(files.outputFile);
    await expect(readFile(files.workFile, "utf8")).resolves.toBe("work via -o");
  });

  it("retries only the format phase in the same session when output validation fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-two-phase-retry-"));
    const files = await createTwoPhaseFiles(dir);
    const requests: WorkingAgentProcessRequest[] = [];

    const output = await runManifestWorkingProvider({
      config: twoPhaseManifestConfig(
        outputFileFollowUpWorking({
          supported: true,
          sessionIdFlag: "--session",
          resumeArgs: [
            "--resume",
            "{{sessionId}}",
            "--prompt-file",
            "{{promptFile}}",
            "--output-file",
            "{{outputFile}}",
          ],
        }),
      ),
      step: twoPhaseStep(),
      role: { size: "medium" },
      cwd: dir,
      target: { provider: "worker" },
      files,
      renderedPrompt: "Do the review.",
      runner: async (request): Promise<WorkingAgentProcessResult> => {
        requests.push(request);
        if (requests.length === 1) {
          await writeFile(request.outputFile, "worker report", "utf8");
          return { exitCode: 0 };
        }
        if (requests.length === 2) {
          await writeFile(request.outputFile, "not json", "utf8");
          return { exitCode: 0 };
        }
        await writeFile(request.outputFile, JSON.stringify({ answer: "recovered" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(output).toEqual({ answer: "recovered" });
    // One work phase + two format attempts; the worker is never re-run.
    expect(requests).toHaveLength(3);
    const phase1Args = requests[0]?.args ?? [];
    const sessionId = phase1Args[phase1Args.length - 1];
    expect(requests[1]?.args).toEqual(requests[2]?.args);
    expect(requests[1]?.args?.[1]).toBe(sessionId);
    await expect(readFile(files.workFile, "utf8")).resolves.toBe("worker report");

    // The retry repair prompt carries the validation diagnostics.
    const repairPrompt = await readFile(files.repairPromptFile, "utf8");
    expect(repairPrompt).toContain("failed validation with these errors");
    expect(repairPrompt).toContain("must contain one JSON object");
  });

  it("throws agent_target_failed with the Phase 1 tail after three failed format attempts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-two-phase-exhausted-"));
    const files = await createTwoPhaseFiles(dir);
    const requests: WorkingAgentProcessRequest[] = [];

    let caught: unknown;
    try {
      await runManifestWorkingProvider({
        config: twoPhaseManifestConfig(
          outputFileFollowUpWorking({
            supported: true,
            sessionIdFlag: "--session",
            resumeArgs: [
              "--resume",
              "{{sessionId}}",
              "--prompt-file",
              "{{promptFile}}",
              "--output-file",
              "{{outputFile}}",
            ],
          }),
        ),
        step: twoPhaseStep(),
        role: { size: "medium" },
        cwd: dir,
        target: { provider: "worker" },
        files,
        renderedPrompt: "Do the review.",
        runner: async (request): Promise<WorkingAgentProcessResult> => {
          requests.push(request);
          if (requests.length === 1) {
            await writeFile(request.outputFile, "IMPORTANT WORK TAIL", "utf8");
            return { exitCode: 0 };
          }
          await writeFile(request.outputFile, "still not json", "utf8");
          return { exitCode: 0 };
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TrailStepFailureError);
    const failure = (caught as TrailStepFailureError).failure;
    expect(failure.code).toBe("agent_target_failed");
    const details = failure.details as {
      readonly sessionId: string;
      readonly phase1Tail: string;
      readonly validationDiagnostics: readonly string[];
      readonly attempts: number;
    };
    expect(details.attempts).toBe(3);
    expect(details.phase1Tail).toContain("IMPORTANT WORK TAIL");
    expect(details.validationDiagnostics).toHaveLength(3);
    expect(details.validationDiagnostics[0]).toContain("must contain one JSON object");
    // 1 work phase + 3 format attempts, all in the same session.
    expect(requests).toHaveLength(4);
    const phase1Args = requests[0]?.args ?? [];
    expect(details.sessionId).toBe(phase1Args[phase1Args.length - 1]);
    for (const request of requests.slice(1)) {
      expect(request.args?.[1]).toBe(details.sessionId);
    }
  });

  it("throws agent_provider_invalid when followUp.supported has no resumeArgs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-two-phase-no-resume-"));
    const files = await createTwoPhaseFiles(dir);
    const requests: WorkingAgentProcessRequest[] = [];

    let caught: unknown;
    try {
      await runManifestWorkingProvider({
        config: twoPhaseManifestConfig(
          outputFileFollowUpWorking({ supported: true, sessionIdFlag: "--session" }),
        ),
        step: twoPhaseStep(),
        role: { size: "medium" },
        cwd: dir,
        target: { provider: "worker" },
        files,
        renderedPrompt: "Do the review.",
        runner: async (request): Promise<WorkingAgentProcessResult> => {
          requests.push(request);
          return { exitCode: 0 };
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TrailStepFailureError);
    expect((caught as TrailStepFailureError).failure.code).toBe("agent_provider_invalid");
    expect(requests).toHaveLength(0);
  });

  it("keeps the single-phase path unchanged when followUp is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-two-phase-legacy-"));
    const files = await createTwoPhaseFiles(dir);
    const requests: WorkingAgentProcessRequest[] = [];

    const working = envelopeFollowUpWorking();
    delete working.followUp;

    const output = await runManifestWorkingProvider({
      config: twoPhaseManifestConfig(working),
      step: twoPhaseStep(),
      role: { size: "medium" },
      cwd: dir,
      target: { provider: "worker" },
      files,
      renderedPrompt: "Do the review.",
      runner: async (request): Promise<WorkingAgentProcessResult> => {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ result: JSON.stringify({ answer: "legacy" }) }),
        };
      },
    });

    expect(output).toEqual({ answer: "legacy" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args).toEqual(["--prompt-file", files.promptFile]);
    // The front-loaded prompt is not overwritten and no work/repair files appear.
    await expect(readFile(files.promptFile, "utf8")).resolves.toBe("Front-loaded prompt.");
  });

  it("keeps the single-phase path when followUp.supported is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-two-phase-legacy-false-"));
    const files = await createTwoPhaseFiles(dir);
    const requests: WorkingAgentProcessRequest[] = [];

    const output = await runManifestWorkingProvider({
      config: twoPhaseManifestConfig(
        outputFileFollowUpWorking({ supported: false, reason: "no resume support" }),
      ),
      step: twoPhaseStep(),
      role: { size: "medium" },
      cwd: dir,
      target: { provider: "worker" },
      files,
      renderedPrompt: "Do the review.",
      runner: async (request): Promise<WorkingAgentProcessResult> => {
        requests.push(request);
        await writeFile(request.outputFile, JSON.stringify({ answer: "legacy-false" }), "utf8");
        return { exitCode: 0 };
      },
    });

    expect(output).toEqual({ answer: "legacy-false" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.outputFile).toBe(files.outputFile);
  });
});
