import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tmpProject } from "@trailstep/trailtest";
import { afterAll, describe, expect, it } from "vitest";

import { runWorkflowTool } from "../src/tools/run_workflow.js";

// Thin-adapter test: bounded return (the tool waits only until the run's
// directory materializes — default 2 s budget) with real runId/runDir, while
// the spawned `trailstep run` keeps executing in the background and eventually
// writes events.jsonl into the returned runDir.
//
// Requires built workspace dists (turbo `test` dependsOn ^build):
//   packages/cli/dist/index.js and packages/core/dist/index.js

const cliEntry = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
const coreDistUrl = pathToFileURL(
  fileURLToPath(new URL("../../core/dist/index.js", import.meta.url)),
).href;

function workflowSource(): string {
  return `import { done, step } from '${coreDistUrl}';

const schema = {
  validate: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  diagnostics: () => [],
  assert: (value, label) => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
    throw new Error(label + ' must be an object');
  },
};

export default {
  id: 'review',
  input: schema,
  output: schema,
  start: (input) => step({ id: 'prepare' })
    .do((stepInput) => done({ ...stepInput, prepared: true }))(input),
};`;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return predicate();
}

describe("run_workflow tool (thin adapter)", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("returns bounded with real runId/runDir once the run materializes (not at completion)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-mcp-run-workflow-"));
    tmpDirs.push(cwd);
    await mkdir(join(cwd, "workflows"), { recursive: true });
    await writeFile(join(cwd, "workflows", "review.mjs"), workflowSource(), "utf8");

    const startedAt = Date.now();
    const result = await runWorkflowTool({
      workflowRef: "./workflows/review.mjs",
      input: { ok: true },
      cwd,
      cliEntry,
      // Generous materialization budget so slow CI measures the fast path, not
      // the timeout; the default stays 2000 ms for the MCP surface.
      verifyStartTimeoutMs: 15_000,
      now: () => new Date("2026-01-02T03:04:05.678Z"),
      randomSuffix: () => "aabbccdd",
    });
    const elapsedMs = Date.now() - startedAt;

    // Bounded: returns once the run dir exists (node boot + CLI startup),
    // long before awaiting workflow completion. The bound is deliberately
    // generous - the machine may be loaded, and the suites run in parallel -
    // because what this asserts is that the tool returned through the
    // materialization fast path instead of exhausting its verification budget.
    expect(elapsedMs).toBeLessThan(12_000);
    expect(result.status).toBe("started");

    // Real ids from the generate-run-name scheme (no Date.now fake).
    expect(result.runId).toBe("review-20260102-030405-aabbccdd");
    expect(result.runDir).toBe(join(cwd, ".trailstep", "runs", result.runId));

    // The background `trailstep run` writes real run artifacts into runDir.
    const eventsPath = join(result.runDir, "events.jsonl");
    const appeared = await waitFor(async () => {
      try {
        await access(eventsPath);
        return true;
      } catch {
        return false;
      }
    }, 30_000);
    expect(appeared).toBe(true);

    const events = await readFile(eventsPath, "utf8");
    expect(events).toContain("workflow.started");

    // Let the detached run reach a terminal event before cleanup.
    const reachedTerminal = await waitFor(async () => {
      try {
        const text = await readFile(eventsPath, "utf8");
        return /workflow\.(completed|failed|cancelled)/u.test(text);
      } catch {
        return false;
      }
    }, 30_000);
    expect(reachedTerminal).toBe(true);
    expect(await readFile(eventsPath, "utf8")).toContain("workflow.completed");
  }, 45_000);

  it("rejects an empty workflowRef", async () => {
    await expect(runWorkflowTool({ workflowRef: "   " })).rejects.toThrow(/workflowRef/u);
    await expect(runWorkflowTool({ workflowRef: "" as unknown as string })).rejects.toThrow(
      /workflowRef/u,
    );
  });

  it("rejects non-object input", async () => {
    await expect(
      runWorkflowTool({ workflowRef: "pkg:someWorkflow", input: [1, 2] }),
    ).rejects.toThrow(/input/u);
    await expect(
      runWorkflowTool({ workflowRef: "pkg:someWorkflow", input: "nope" }),
    ).rejects.toThrow(/input/u);
    await expect(runWorkflowTool({ workflowRef: "pkg:someWorkflow", input: 42 })).rejects.toThrow(
      /input/u,
    );
  });
});

describe("run_workflow start verification (never reports a run that never exists)", () => {
  it("returns failed with a clear error when the configured CLI entry does not exist", async () => {
    const root = tmpProject("trailstep-mcp-run-bad-entry-");

    const result = await runWorkflowTool({
      workflowRef: "flows/demo",
      cwd: root,
      cliEntry: join(root, "missing-cli", "index.js"),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("CLI entry not found");
    expect(result.error).toContain("TRAILSTEP_CLI_ENTRY");
    expect(existsSync(result.runDir)).toBe(false);
  });

  it("refuses the win32 PATH fallback instead of letting cmd.exe mangle --input JSON", async () => {
    const root = tmpProject("trailstep-mcp-run-win32-");

    const result = await runWorkflowTool({
      workflowRef: "flows/demo",
      cwd: root,
      env: { TRAILSTEP_CLI_ENTRY: "" },
      platform: "win32",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("win32 PATH fallback");
    expect(result.error).toContain("TRAILSTEP_CLI_ENTRY");
    expect(existsSync(result.runDir)).toBe(false);
  });

  it("reports failed when the background CLI exits before the run materializes", async () => {
    const root = tmpProject("trailstep-mcp-run-dead-cli-");
    const brokenCli = join(root, "broken-cli.mjs");
    await writeFile(brokenCli, "process.exit(3);\n", "utf8");

    const startedAt = Date.now();
    const result = await runWorkflowTool({
      workflowRef: "flows/demo",
      cwd: root,
      cliEntry: brokenCli,
      verifyStartTimeoutMs: 15_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited with code 3/u);
    // The broken CLI exits immediately, so this must not wait out the
    // verification budget. Kept well under it, and loose enough to survive a
    // loaded machine.
    expect(Date.now() - startedAt).toBeLessThan(12_000);
  });

  it("surfaces a spawn failure instead of reporting started", async () => {
    const root = tmpProject("trailstep-mcp-run-spawn-fail-");
    const cliEntryPath = join(root, "cli-entry.js");
    await writeFile(cliEntryPath, "// never runs: the spawn itself fails\n", "utf8");

    const result = await runWorkflowTool({
      workflowRef: "flows/demo",
      cwd: join(root, "does-not-exist"),
      cliEntry: cliEntryPath,
      verifyStartTimeoutMs: 10_000,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/failed to spawn/u);
  });

  it("does not report started while the run directory never appears (bounded budget)", async () => {
    const root = tmpProject("trailstep-mcp-run-no-materialize-");
    const slowCli = join(root, "slow-cli.mjs");
    await writeFile(slowCli, "setTimeout(() => {}, 1500);\n", "utf8");

    const startedAt = Date.now();
    const result = await runWorkflowTool({
      workflowRef: "flows/demo",
      cwd: root,
      cliEntry: slowCli,
      verifyStartTimeoutMs: 300,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe("failed");
    expect(result.error).toContain("did not appear");
    // Bounded: waited out the budget, then gave up — no unbounded hang.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
  });
});
