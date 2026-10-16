import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { runWorkflowTool } from "../src/tools/run_workflow.js";

// Thin-adapter test: quick return (<1s) with real runId/runDir while the
// spawned `trailstep run` keeps executing in the background and eventually
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

  it("returns <1s with real runId/runDir while events.jsonl appears in the background", async () => {
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
      now: () => new Date("2026-01-02T03:04:05.678Z"),
      randomSuffix: () => "aabbccdd",
    });
    const elapsedMs = Date.now() - startedAt;

    // Quick return without awaiting workflow completion.
    expect(elapsedMs).toBeLessThan(1000);
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
