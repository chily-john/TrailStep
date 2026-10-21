import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  type ContinueRunnerOptions,
  resolveCliEntry,
  spawnContinue,
  trstResume,
} from "../src/tools/trst_resume.js";

let tempRoot: string | undefined;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  tempRoot = tempRoot ?? dir;
  return dir;
}

async function writeStartedRun(runDir: string): Promise<void> {
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
    })}\n`,
    "utf8",
  );
}

afterAll(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

describe("trst_resume delegates to the real continue path", () => {
  it("invokes the CLI continue command with the resolved run dir", async () => {
    const runDir = await makeTempDir("trst-resume-basic");
    await writeStartedRun(runDir);

    const calls: ContinueRunnerOptions[] = [];
    const runner = async (options: ContinueRunnerOptions) => {
      calls.push(options);
      return { exitCode: 0, stdout: "Workflow completed: wf-test at x\n", stderr: "" };
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

  it("maps the waiting continue output to status waiting", async () => {
    const runDir = await makeTempDir("trst-resume-waiting");
    await writeStartedRun(runDir);

    const result = await trstResume({
      runId: runDir,
      runner: async () => ({
        exitCode: 0,
        stdout: "Workflow still waiting: run (wait-1)\nMissing answer: waits/a.json\n",
        stderr: "",
      }),
    });

    expect(result.resumed).toBe(true);
    expect(result.status).toBe("waiting");
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

  it("maps cancelled continue output to status cancelled", async () => {
    const runDir = await makeTempDir("trst-resume-cancelled");
    await writeStartedRun(runDir);

    const result = await trstResume({
      runId: runDir,
      runner: async () => ({
        exitCode: 0,
        stdout: "Workflow cancelled: run\n",
        stderr: "",
      }),
    });

    expect(result.resumed).toBe(true);
    expect(result.status).toBe("cancelled");
  });

  it("passes the caller env through to the continue runner", async () => {
    const runDir = await makeTempDir("trst-resume-env-thread");
    await writeStartedRun(runDir);

    const calls: ContinueRunnerOptions[] = [];
    const env = { TRAILSTEP_RUNS_ROOT: "custom-runs", TRST_THREAD_CHECK: "bar" };
    const result = await trstResume({
      runId: runDir,
      env,
      runner: async (options) => {
        calls.push(options);
        return { exitCode: 0, stdout: "Workflow completed: wf-test at x\n", stderr: "" };
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

describe("spawnContinue merges caller env over process.env", () => {
  it("passes TRAILSTEP_* overrides and the underlying process.env into the spawned CLI", async () => {
    const dir = await makeTempDir("trst-spawn-env");
    const scriptPath = join(dir, "fake-cli.cjs");
    const dumpPath = join(dir, "env-dump.json");
    await writeFile(
      scriptPath,
      [
        'const fs = require("node:fs");',
        "fs.writeFileSync(",
        "  process.env.TRST_TEST_ENV_DUMP,",
        "  JSON.stringify({",
        "    marker: process.env.TRST_TEST_MARKER,",
        "    runsRoot: process.env.TRAILSTEP_RUNS_ROOT ?? null,",
        "    hasPath: Boolean(process.env.PATH),",
        "  }),",
        '  "utf8",',
        ");",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await spawnContinue({
      cliEntry: scriptPath,
      runDir: join(dir, "run"),
      cwd: dir,
      env: {
        TRST_TEST_ENV_DUMP: dumpPath,
        TRST_TEST_MARKER: "caller",
        TRAILSTEP_RUNS_ROOT: "custom-runs",
      },
    });

    expect(result.exitCode).toBe(0);
    const dump = JSON.parse(await readFile(dumpPath, "utf8")) as {
      marker?: string;
      runsRoot?: string | null;
      hasPath?: boolean;
    };
    // Caller env wins over process.env…
    expect(dump.marker).toBe("caller");
    expect(dump.runsRoot).toBe("custom-runs");
    // …while the rest of process.env still reaches the child.
    expect(dump.hasPath).toBe(true);
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
