import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { trstAnswer } from "../src/tools/trst_answer.js";

let tempRoot: string;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  tempRoot = tempRoot ?? dir;
  return dir;
}

interface WaitRunSpec {
  readonly runDir: string;
  readonly waitId: string;
  readonly message: string;
  readonly branchId?: string;
  readonly answerFile: string;
  readonly requestFile?: string;
  readonly satisfied?: boolean;
}

async function writeWaitRun(spec: WaitRunSpec): Promise<void> {
  const event = (type: string, payload: Record<string, unknown>): string =>
    JSON.stringify({
      id: `evt-${type}-${Math.random().toString(36).slice(2)}`,
      runId: "run-test",
      workflowId: "wf-test",
      stepId: "step-1",
      type,
      timestamp: new Date().toISOString(),
      schemaVersion: "v0",
      payload,
    });

  const lines = [
    event("workflow.started", { workflowRef: "./wf.ts#w" }),
    event("wait.started", {
      waitId: spec.waitId,
      kind: "input",
      message: spec.message,
      artifactPaths: {
        requestFile: spec.requestFile ?? "waits/req.json",
        answerFile: spec.answerFile,
      },
      ...(spec.branchId === undefined ? {} : { branchId: spec.branchId }),
    }),
  ];
  if (spec.satisfied) {
    lines.push(
      event("wait.satisfied", {
        waitId: spec.waitId,
        kind: "input",
        artifactPaths: {
          requestFile: spec.requestFile ?? "waits/req.json",
          answerFile: spec.answerFile,
        },
        ...(spec.branchId === undefined ? {} : { branchId: spec.branchId }),
      }),
    );
  }

  await mkdir(spec.runDir, { recursive: true });
  await writeFile(join(spec.runDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

afterAll(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("trst_answer tool adapters over the real wait answer files", () => {
  it("writes the run's real wait answer file and returns verbatim question + recommendation", async () => {
    const runDir = await makeTempDir("trst-answer-basic");
    const question = "Wie geht's — status? 状态?";
    await writeWaitRun({
      runDir,
      waitId: "deploy-input",
      message: question,
      answerFile: join("waits", "deploy-input.answer.json"),
    });

    const answer = { url: "https://example.test", approved: true };
    const result = await trstAnswer({ runId: runDir, waitId: "deploy-input", answer });

    expect(result.persisted).toBe(true);
    expect(result.question).toBe(question);
    expect(result.recommendation).toBe(JSON.stringify(answer));
    expect(result.branchId).toBe("root");
    expect(result.answerFile).toBe(join("waits", "deploy-input.answer.json"));
    expect(result.runDir).toBe(runDir);

    const written = await readFile(join(runDir, "waits", "deploy-input.answer.json"), "utf8");
    expect(written).toBe(`${JSON.stringify(answer, null, 2)}\n`);
  });

  it("resolves a run by name under the cwd runs root", async () => {
    const cwd = await makeTempDir("trst-answer-runs-root");
    const runDir = join(cwd, ".trailstep", "runs", "shiny-wolf-run");
    await writeWaitRun({
      runDir,
      waitId: "wait-1",
      message: "Need a value",
      answerFile: "waits/wait-1.answer.json",
    });

    const result = await trstAnswer({
      runId: "shiny-wolf-run",
      waitId: "wait-1",
      answer: { ok: 1 },
      cwd,
    });

    expect(result.persisted).toBe(true);
    expect(result.runDir).toBe(runDir);
    expect(await readFile(join(runDir, "waits", "wait-1.answer.json"), "utf8")).toContain(
      '"ok": 1',
    );
  });

  it("honors TRAILSTEP_RUNS_ROOT like the CLI", async () => {
    const cwd = await makeTempDir("trst-answer-env-root");
    const runsRoot = join(cwd, "elsewhere", "runs");
    const runDir = join(runsRoot, "env-run");
    await writeWaitRun({
      runDir,
      waitId: "wait-1",
      message: "Env question",
      answerFile: "waits/wait-1.answer.json",
    });

    const result = await trstAnswer({
      runId: "env-run",
      waitId: "wait-1",
      answer: { ok: 2 },
      cwd,
      env: { TRAILSTEP_RUNS_ROOT: runsRoot },
    });

    expect(result.persisted).toBe(true);
    expect(result.runDir).toBe(runDir);
  });

  it("requires a branchId when the same waitId is pending on parallel branches", async () => {
    const runDir = await makeTempDir("trst-answer-ambiguous");
    const events = [
      JSON.stringify({
        id: "evt-start",
        runId: "run-test",
        workflowId: "wf-test",
        type: "workflow.started",
        timestamp: new Date().toISOString(),
        schemaVersion: "v0",
        payload: { workflowRef: "./wf.ts#w" },
      }),
    ];
    for (const branchId of ["track-a", "track-b"]) {
      events.push(
        JSON.stringify({
          id: `evt-wait-${branchId}`,
          runId: "run-test",
          workflowId: "wf-test",
          stepId: `step-${branchId}`,
          type: "wait.started",
          timestamp: new Date().toISOString(),
          schemaVersion: "v0",
          payload: {
            waitId: "review",
            kind: "input",
            message: `Question on ${branchId}`,
            branchId,
            artifactPaths: {
              requestFile: `waits/${branchId}.req.json`,
              answerFile: `waits/${branchId}.answer.json`,
            },
          },
        }),
      );
    }
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), `${events.join("\n")}\n`, "utf8");

    const result = await trstAnswer({ runId: runDir, waitId: "review", answer: { ok: 1 } });

    expect(result.persisted).toBe(false);
    expect(result.error).toContain("track-a, track-b");
    expect(existsSync(join(runDir, "waits", "track-a.answer.json"))).toBe(false);
  });

  it("answers the branch-specific wait when branchId is supplied", async () => {
    const runDir = await makeTempDir("trst-answer-branch");
    const events = [
      JSON.stringify({
        id: "evt-start",
        runId: "run-test",
        workflowId: "wf-test",
        type: "workflow.started",
        timestamp: new Date().toISOString(),
        schemaVersion: "v0",
        payload: { workflowRef: "./wf.ts#w" },
      }),
    ];
    for (const branchId of ["track-a", "track-b"]) {
      events.push(
        JSON.stringify({
          id: `evt-wait-${branchId}`,
          runId: "run-test",
          workflowId: "wf-test",
          stepId: `step-${branchId}`,
          type: "wait.started",
          timestamp: new Date().toISOString(),
          schemaVersion: "v0",
          payload: {
            waitId: "review",
            kind: "input",
            message: `Question on ${branchId}`,
            branchId,
            artifactPaths: {
              requestFile: `waits/${branchId}.req.json`,
              answerFile: `waits/${branchId}.answer.json`,
            },
          },
        }),
      );
    }
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), `${events.join("\n")}\n`, "utf8");

    const result = await trstAnswer({
      runId: runDir,
      waitId: "review",
      branchId: "track-b",
      answer: { ok: "b" },
    });

    expect(result.persisted).toBe(true);
    expect(result.branchId).toBe("track-b");
    expect(result.question).toBe("Question on track-b");
    expect(existsSync(join(runDir, "waits", "track-a.answer.json"))).toBe(false);
  });

  it("does not invent a fallback when no pending wait matches (persisted false, no file)", async () => {
    const runDir = await makeTempDir("trst-answer-no-wait");
    await writeWaitRun({
      runDir,
      waitId: "wait-1",
      message: "Question",
      answerFile: "waits/wait-1.answer.json",
      satisfied: true,
    });

    const result = await trstAnswer({ runId: runDir, waitId: "wait-1", answer: { ok: 1 } });

    expect(result.persisted).toBe(false);
    expect(result.error).toContain("Pending wait not found");
    expect(existsSync(join(runDir, "waits", "wait-1.answer.json"))).toBe(false);
  });

  it("does not invent a fallback when the wait has no answer artifact", async () => {
    const runDir = await makeTempDir("trst-answer-no-artifact");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt-start",
        runId: "run-test",
        workflowId: "wf-test",
        type: "workflow.started",
        timestamp: new Date().toISOString(),
        schemaVersion: "v0",
        payload: { workflowRef: "./wf.ts#w" },
      })}\n${JSON.stringify({
        id: "evt-wait",
        runId: "run-test",
        workflowId: "wf-test",
        stepId: "step-1",
        type: "wait.started",
        timestamp: new Date().toISOString(),
        schemaVersion: "v0",
        payload: { waitId: "wait-1", kind: "check", message: "Check?" },
      })}\n`,
      "utf8",
    );

    const result = await trstAnswer({ runId: runDir, waitId: "wait-1", answer: { ok: 1 } });

    expect(result.persisted).toBe(false);
    expect(result.error).toContain("no answer artifact");
  });

  it("rejects non-object answers like the CLI does", async () => {
    const runDir = await makeTempDir("trst-answer-non-object");
    const result = await trstAnswer({
      runId: runDir,
      waitId: "wait-1",
      answer: [1, 2, 3] as unknown as Record<string, unknown>,
    });

    expect(result.persisted).toBe(false);
    expect(result.error).toContain("plain JSON object");
  });

  it("keeps the persisted-answer report when the continue runner throws", async () => {
    const runDir = await makeTempDir("trst-answer-throwing-runner");
    await writeWaitRun({
      runDir,
      waitId: "wait-1",
      message: "Question",
      answerFile: "waits/wait-1.answer.json",
    });

    const result = await trstAnswer({
      runId: runDir,
      waitId: "wait-1",
      answer: { ok: true },
      continueAfterAnswer: true,
      // Guarantees trstResume resolves a cli entry so it reaches the runner.
      env: { TRAILSTEP_CLI_ENTRY: join(runDir, "fake-cli-entry.js") },
      resumeRunner: async () => {
        throw new Error("continue runner exploded");
      },
    });

    // The persisted-answer report survives a throwing continue path.
    expect(result.persisted).toBe(true);
    expect(result.answerFile).toBe("waits/wait-1.answer.json");
    expect(result.recommendation).toBe(JSON.stringify({ ok: true }));
    expect(result.continued).toEqual({ resumed: false, error: "continue runner exploded" });
    // The answer artifact was written before continueAfterAnswer ran.
    expect(existsSync(join(runDir, "waits", "wait-1.answer.json"))).toBe(true);
  });
});
