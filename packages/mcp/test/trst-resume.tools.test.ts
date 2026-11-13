import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Event } from "@trailstep/core";
import { afterAll, describe, expect, it } from "vitest";

import {
  type ContinueRunnerOptions,
  resolveCliEntry,
  statusFromEvents,
  trstResume,
} from "../src/tools/trst_resume.js";

let tempRoot: string | undefined;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  tempRoot = tempRoot ?? dir;
  return dir;
}

function eventLine(type: Event["type"], index: number): string {
  return JSON.stringify({
    id: `evt-${index}-${type}`,
    runId: "run-test",
    workflowId: "wf-test",
    type,
    timestamp: new Date().toISOString(),
    schemaVersion: "v0",
    payload: {},
  });
}

/** Writes the given event types (starting at `workflow.started`) as the run's trail. */
async function writeRunEvents(
  runDir: string,
  ...extraTypes: readonly Event["type"][]
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const types: readonly Event["type"][] = ["workflow.started", ...extraTypes];
  const lines = types.map((type, index) => eventLine(type, index + 1));
  await writeFile(join(runDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function writeStartedRun(runDir: string): Promise<void> {
  await writeRunEvents(runDir);
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await sleep(25);
    }
  }
  throw new Error(`file never appeared: ${path}`);
}

afterAll(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("trst_resume delegates to the real continue path", () => {
  it("invokes the CLI continue command with the resolved run dir", async () => {
    const runDir = await makeTempDir("trst-resume-basic");
    await writeRunEvents(runDir, "workflow.completed");

    const calls: ContinueRunnerOptions[] = [];
    const runner = async (options: ContinueRunnerOptions) => {
      calls.push(options);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await trstResume({ runId: runDir, runner });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runDir).toBe(runDir);
    expect(calls[0]?.cliEntry.length).toBeGreaterThan(0);
    expect(result).toEqual({
      resumed: true,
      runDir,
      status: "completed",
    });
  });

  it("reports status waiting for a run parked on a durable wait", async () => {
    const runDir = await makeTempDir("trst-resume-waiting");
    await writeRunEvents(runDir, "wait.started");

    const result = await trstResume({
      runId: runDir,
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(result.resumed).toBe(true);
    expect(result.status).toBe("waiting");
    expect(result.background).toBeUndefined();
  });

  it("maps a failed continue exit to resumed false with the CLI error text", async () => {
    const runDir = await makeTempDir("trst-resume-failed");
    await writeStartedRun(runDir);

    const result = await trstResume({
      runId: runDir,
      runner: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Run is not waiting: x\n",
      }),
    });

    expect(result.resumed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Run is not waiting: x");
  });

  it("reports status cancelled for a cancelled run", async () => {
    const runDir = await makeTempDir("trst-resume-cancelled");
    await writeRunEvents(runDir, "workflow.cancelled");

    const result = await trstResume({
      runId: runDir,
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(result.resumed).toBe(true);
    expect(result.status).toBe("cancelled");
  });

  it("passes the caller env through to the continue runner", async () => {
    const runDir = await makeTempDir("trst-resume-env-thread");
    await writeRunEvents(runDir, "workflow.completed");

    const calls: ContinueRunnerOptions[] = [];
    const env = { TRAILSTEP_RUNS_ROOT: "custom-runs", TRST_THREAD_CHECK: "bar" };
    const result = await trstResume({
      runId: runDir,
      env,
      runner: async (options) => {
        calls.push(options);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.resumed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toEqual(env);
  });

  it("does not call continue for a run directory without events", async () => {
    const missingDir = await makeTempDir("trst-resume-missing");
    let runnerCalled = false;
    const result = await trstResume({
      runId: missingDir,
      runner: async () => {
        runnerCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(runnerCalled).toBe(false);
    expect(result.resumed).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("does not call continue for a run without workflow.started", async () => {
    const runDir = await makeTempDir("trst-resume-no-start");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt-step",
        runId: "run-test",
        workflowId: "wf-test",
        type: "step.completed",
        timestamp: new Date().toISOString(),
        schemaVersion: "v0",
        payload: {},
      })}\n`,
      "utf8",
    );

    let runnerCalled = false;
    const result = await trstResume({
      runId: runDir,
      runner: async () => {
        runnerCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(runnerCalled).toBe(false);
    expect(result.resumed).toBe(false);
    expect(result.error).toContain("no workflow.started event");
  });
});

describe("trst_resume starts the continue detached and returns in bounded time", () => {
  it("returns while the continue is still running instead of awaiting it", async () => {
    const dir = await makeTempDir("trst-resume-detached");
    const runDir = join(dir, "run");
    await writeStartedRun(runDir);
    // Boots, then sits doing nothing observable — exactly like a continue that is
    // loading modules and discovering workflows. It dies on its own so the child
    // does not outlive the test run.
    const fakeCli = join(dir, "slow-cli.mjs");
    await writeFile(fakeCli, "setTimeout(() => process.exit(0), 3000);\n", "utf8");

    const startedAt = Date.now();
    const result = await trstResume({
      runId: runDir,
      env: { TRAILSTEP_CLI_ENTRY: fakeCli },
      verifyStartTimeoutMs: 300,
    });
    const elapsed = Date.now() - startedAt;

    // The regression test for the blocking bug: the call resolves in the
    // verification window, not after the multi-minute continue.
    expect(elapsed).toBeLessThan(5000);
    expect(result.resumed).toBe(true);
    expect(result.status).toBe("running");
    expect(result.background).toBe(true);
    expect(result.error).toBeUndefined();
  }, 20_000);

  it("reports failed when the continue exits non-zero before producing events", async () => {
    const dir = await makeTempDir("trst-resume-detached-fail");
    const runDir = join(dir, "run");
    await writeStartedRun(runDir);
    const fakeCli = join(dir, "failing-cli.mjs");
    await writeFile(fakeCli, "process.exit(7);\n", "utf8");

    const result = await trstResume({
      runId: runDir,
      env: { TRAILSTEP_CLI_ENTRY: fakeCli },
      verifyStartTimeoutMs: 10_000,
    });

    expect(result.resumed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("code 7");
  }, 20_000);

  it("returns started once the continue takes the run lock", async () => {
    const dir = await makeTempDir("trst-resume-detached-lock");
    const runDir = join(dir, "run");
    await writeStartedRun(runDir);
    const fakeCli = join(dir, "lock-cli.mjs");
    // The continue re-enters core, which takes run.lock before appending events.
    await writeFile(
      fakeCli,
      [
        'import { writeFile } from "node:fs/promises";',
        'import { join } from "node:path";',
        "const runDir = process.argv[3];",
        "await writeFile(",
        '  join(runDir, "run.lock"),',
        "  JSON.stringify({",
        "    schemaVersion: 1,",
        '    runId: "run",',
        "    pid: process.pid,",
        "    startedAt: new Date().toISOString(),",
        "    lastHeartbeatAt: new Date().toISOString(),",
        '    nonce: "fake-continue",',
        "  }),",
        '  "utf8",',
        ");",
        "setTimeout(() => process.exit(0), 2000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const startedAt = Date.now();
    const result = await trstResume({
      runId: runDir,
      env: { TRAILSTEP_CLI_ENTRY: fakeCli },
      verifyStartTimeoutMs: 10_000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.resumed).toBe(true);
    // Lock evidence ends the verification instead of waiting out the budget.
    expect(elapsed).toBeLessThan(9000);
  }, 20_000);

  it("merges caller env over process.env for the background continue", async () => {
    const root = await makeTempDir("trst-resume-detached-env");
    const runsRoot = join(root, "custom-runs");
    const runDir = join(runsRoot, "env-run");
    await writeStartedRun(runDir);
    const scriptPath = join(root, "fake-cli.mjs");
    const dumpPath = join(root, "env-dump.json");
    await writeFile(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(",
        "  process.env.TRST_TEST_ENV_DUMP,",
        "  JSON.stringify({",
        "    marker: process.env.TRST_TEST_MARKER,",
        "    runsRoot: process.env.TRAILSTEP_RUNS_ROOT ?? null,",
        "    hasPath: Boolean(process.env.PATH),",
        "  }),",
        '  "utf8",',
        ");",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await trstResume({
      runId: "env-run",
      cwd: root,
      env: {
        TRAILSTEP_CLI_ENTRY: scriptPath,
        TRAILSTEP_RUNS_ROOT: runsRoot,
        TRST_TEST_ENV_DUMP: dumpPath,
        TRST_TEST_MARKER: "caller",
      },
      verifyStartTimeoutMs: 10_000,
    });

    expect(result.resumed).toBe(true);
    expect(result.runDir).toBe(runDir);

    const dump = JSON.parse(await waitForFile(dumpPath)) as {
      marker?: string;
      runsRoot?: string | null;
      hasPath?: boolean;
    };
    // Caller env wins over process.env…
    expect(dump.marker).toBe("caller");
    expect(dump.runsRoot).toBe(runsRoot);
    // …while the rest of process.env still reaches the child.
    expect(dump.hasPath).toBe(true);
  }, 20_000);
});

describe("statusFromEvents derives the continue status from the trail, never from CLI prose", () => {
  const event = (type: Event["type"]): Event => ({
    id: `evt-${type}`,
    runId: "run-test",
    workflowId: "wf-test",
    type,
    timestamp: new Date(0).toISOString(),
    schemaVersion: "v0",
    payload: {},
  });

  it("maps each terminal event to its status", () => {
    expect(statusFromEvents([event("workflow.started"), event("workflow.completed")])).toBe(
      "completed",
    );
    expect(statusFromEvents([event("workflow.started"), event("workflow.failed")])).toBe("failed");
    expect(statusFromEvents([event("workflow.started"), event("workflow.cancelled")])).toBe(
      "cancelled",
    );
  });

  it("never maps a pending cancel request to cancelled or waiting", () => {
    const bareCancel = [event("workflow.started"), event("workflow.cancelRequested")];
    expect(statusFromEvents(bareCancel)).toBe("running");
    // A pending wait must not be reported as answerable while the request is pending.
    expect(
      statusFromEvents([
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("wait.started"),
      ]),
    ).toBe("running");
    expect(
      statusFromEvents([
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.cancelled"),
      ]),
    ).toBe("cancelled");
  });

  it("ignores a cancel request superseded by workflow.resumed", () => {
    expect(
      statusFromEvents([
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.resumed"),
        event("step.started"),
      ]),
    ).toBe("running");
  });

  it("ignores a terminal event from a superseded cycle", () => {
    expect(
      statusFromEvents([
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.cancelled"),
        event("workflow.resumed"),
        event("step.started"),
      ]),
    ).toBe("running");
  });

  it("keeps running when a new request follows a resume, never waiting", () => {
    expect(
      statusFromEvents([
        event("workflow.started"),
        event("workflow.cancelRequested"),
        event("workflow.resumed"),
        event("step.started"),
        event("workflow.cancelRequested"),
      ]),
    ).toBe("running");
  });

  it("maps a trailing wait.started to waiting", () => {
    expect(statusFromEvents([event("workflow.started"), event("wait.started")])).toBe("waiting");
  });

  it("maps a mid-run trail to running", () => {
    expect(statusFromEvents([event("workflow.started"), event("step.started")])).toBe("running");
  });

  it("maps an empty trail to unknown", () => {
    expect(statusFromEvents([])).toBe("unknown");
  });
});

describe("CLI entry resolution for the continue adapter", () => {
  it("honors the TRAILSTEP_CLI_ENTRY override", () => {
    expect(resolveCliEntry({ TRAILSTEP_CLI_ENTRY: "C:/cli/dist/index.js" })).toBe(
      "C:/cli/dist/index.js",
    );
  });

  it("resolves an existing workspace cli entry (or undefined when unbuilt)", () => {
    const entry = resolveCliEntry({});
    if (entry === undefined) {
      // Unbuilt workspace: the resolver must return undefined, not a bogus path.
      expect(entry).toBeUndefined();
      return;
    }
    expect(existsSync(entry)).toBe(true);
    expect(entry.replace(/\\/gu, "/")).toContain("packages/cli/dist/index.js");
  });
});
