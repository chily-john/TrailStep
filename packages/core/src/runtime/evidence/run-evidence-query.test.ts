import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import { parseRunEvidence } from "../../contracts/evidence/evidence.schema.js";
import type {
  EvidenceSourceRef,
  RunEvidenceRunRef,
} from "../../contracts/evidence/evidence.types.js";
import {
  inspectRunEvidence,
  listRunEvidence,
  resolveSourceLink,
  retrieveEvidence,
} from "./run-evidence-query.js";

const project = { kind: "explicit", key: "test/project" } as const;
let eventCounter = 0;

function event(
  type: Event["type"],
  overrides: {
    readonly id?: string;
    readonly stepId?: string;
    readonly workflowId?: string;
    readonly timestamp?: string;
    readonly payload?: Record<string, unknown>;
  } = {},
): Event {
  eventCounter += 1;
  return {
    id: overrides.id ?? `evt_${eventCounter}_${type}`,
    runId: "run-1",
    workflowId: overrides.workflowId ?? "workflow-1",
    ...(overrides.stepId === undefined ? {} : { stepId: overrides.stepId }),
    type,
    timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: overrides.payload ?? {},
  };
}

async function makeRunsRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "trailstep-evidence-query-"));
}

async function writeRun(
  runsRoot: string,
  runId: string,
  events: readonly Event[],
  options: {
    readonly track?: Record<string, unknown>;
    readonly artifacts?: Record<string, string>;
  } = {},
): Promise<string> {
  const runDir = join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "events.jsonl"),
    events.length === 0 ? "" : `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  if (options.track !== undefined) {
    await writeFile(join(runDir, "track.json"), `${JSON.stringify(options.track)}\n`, "utf8");
  }
  for (const [artifactPath, content] of Object.entries(options.artifacts ?? {})) {
    const target = join(runDir, artifactPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return runDir;
}

async function writeArchive(
  runsRoot: string,
  runId: string,
  manifest: Record<string, unknown>,
  payload: Buffer,
): Promise<{ readonly gzPath: string; readonly manifestPath: string }> {
  const archiveDir = join(runsRoot, ".archive");
  await mkdir(archiveDir, { recursive: true });
  const gzPath = join(archiveDir, `${runId}.json.gz`);
  const manifestPath = join(archiveDir, `${runId}.manifest.json`);
  await writeFile(gzPath, payload);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { gzPath, manifestPath };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else {
        files[relative(root, target)] = (await readFile(target)).toString("base64");
      }
    }
  }
  await visit(root);
  return files;
}

function sourceRef(
  runId: string,
  selector: { artifactPath?: string; eventId?: string },
): EvidenceSourceRef {
  return {
    run: {
      project,
      runId,
      identityQuality: "explicit",
    },
    ...(selector.artifactPath === undefined
      ? { eventId: selector.eventId ?? "evt_missing" }
      : { artifactPath: selector.artifactPath }),
  };
}

describe("bounded evidence query", () => {
  it("derives waiting, keeps wait text out of default DTOs, and never exposes prompt/output canaries", async () => {
    const runsRoot = await makeRunsRoot();
    const canary = "CANARY-WAIT-PROMPT-SECRET";
    const runDir = await writeRun(
      runsRoot,
      "waiting-run",
      [
        event("workflow.started"),
        event("step.started", { stepId: "approval" }),
        event("wait.started", {
          stepId: "approval",
          payload: {
            waitId: "approve",
            branchId: "root",
            message: canary,
            artifactPaths: { answerFile: "steps/0001-approval/waits/approve/answer.json" },
          },
        }),
      ],
      {
        track: { runId: "waiting-run", status: "running", ownerPid: 2_147_483_647 },
        artifacts: {
          "prompt.txt": canary,
          "steps/0001-approval/output.json": JSON.stringify({ output: canary }),
          "transcript.txt": canary,
          "state.json": JSON.stringify({ output: canary, token: canary, count: 2 }),
        },
      },
    );

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 10_000 } });
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.execution.state).toBe("waiting");
    expect(listed.entries[0]?.execution.diagnostics).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(canary);

    const inspected = await inspectRunEvidence({ runsRoot, project, runId: "waiting-run" });
    expect(inspected.status).toBe("found");
    expect(inspected.evidence?.execution.state).toBe("waiting");
    expect(inspected.pendingWaits).toEqual([
      {
        waitId: "approve",
        branchId: "root",
        stepId: "approval",
        answerFile: "steps/0001-approval/waits/approve/answer.json",
      },
    ]);
    expect(JSON.stringify(inspected)).not.toContain(canary);

    const denied = await retrieveEvidence({
      runsRoot,
      sourceRef: sourceRef("waiting-run", { artifactPath: "prompt.txt" }),
    });
    expect(denied.status).toBe("unavailable");
    if (denied.status === "unavailable") {
      expect(denied.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "unsupported-source",
      ]);
    }

    const stateExcerpt = await retrieveEvidence({
      runsRoot,
      sourceRef: sourceRef("waiting-run", { artifactPath: "state.json" }),
    });
    expect(stateExcerpt.status).toBe("ok");
    if (stateExcerpt.status === "ok") {
      expect(stateExcerpt.excerpt).toContain('"count": 2');
      expect(stateExcerpt.excerpt).not.toContain(canary);
      expect(stateExcerpt.excerpt).not.toContain('"output"');
      expect(stateExcerpt.excerpt).not.toContain('"token"');
    }

    // Use the actual event id from the trail rather than guessing the counter.
    const waitEvent = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event)
      .find((entry) => entry.type === "wait.started");
    expect(waitEvent).toBeDefined();
    const eventExcerpt = await retrieveEvidence({
      runsRoot,
      sourceRef: {
        run: { project, runId: "waiting-run", identityQuality: "explicit" },
        eventId: waitEvent?.id ?? "missing",
      },
    });
    expect(eventExcerpt.status).toBe("ok");
    if (eventExcerpt.status === "ok") {
      expect(eventExcerpt.excerpt).toContain('"waitId": "approve"');
    }
  });

  it("redacts denied JSON keys structurally when a truncated artifact cannot be parsed", async () => {
    const runsRoot = await makeRunsRoot();
    const canary = "CANARY-TRUNCATED-JSON-OUTPUT";
    const content = JSON.stringify({
      output: canary,
      nested: {
        token: canary,
        secret: { output: canary },
      },
      padding: "x".repeat(4096),
      count: 7,
    });
    await writeRun(runsRoot, "truncated-json-run", [event("workflow.started")], {
      artifacts: {
        "state.json": content,
        "branches/root.state.json": `{"output":"${canary}",`,
      },
    });

    for (const maxExcerptBytes of [64, 128, 256, 1024]) {
      const result = await retrieveEvidence({
        runsRoot,
        sourceRef: sourceRef("truncated-json-run", { artifactPath: "state.json" }),
        limits: { maxExcerptBytes },
      });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.excerpt).not.toContain(canary);
        expect(result.truncated).toBe(true);
        expect(result.redacted).toBe(true);
      }
    }

    const malformed = await retrieveEvidence({
      runsRoot,
      sourceRef: sourceRef("truncated-json-run", {
        artifactPath: "branches/root.state.json",
      }),
      limits: { maxExcerptBytes: 4096 },
    });
    expect(malformed.status).toBe("ok");
    if (malformed.status === "ok") {
      expect(malformed.excerpt).not.toContain(canary);
      expect(malformed.redacted).toBe(true);
    }

    const full = await retrieveEvidence({
      runsRoot,
      sourceRef: sourceRef("truncated-json-run", { artifactPath: "state.json" }),
      limits: { maxExcerptBytes: 8192 },
    });
    expect(full.status).toBe("ok");
    if (full.status === "ok") {
      expect(full.excerpt).not.toContain(canary);
      expect(full.excerpt).not.toContain('"output"');
      expect(full.excerpt).not.toContain('"token"');
      expect(full.excerpt).toContain('"count": 7');
    }
  });

  it("maps an orphaned running track to stale + stale-owner under schemaVersion 1", async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(
      runsRoot,
      "orphan-run",
      [event("workflow.started"), event("step.started", { stepId: "work" })],
      {
        track: {
          runId: "orphan-run",
          status: "running",
          ownerPid: 2_147_483_647,
          workflowId: "workflow-1",
        },
      },
    );

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 10_000 } });
    const evidence = listed.entries[0];
    expect(evidence?.execution.state).toBe("stale");
    expect(evidence?.schemaVersion).toBe(1);
    expect(evidence?.execution.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "stale-owner",
    );
    expect(parseRunEvidence(evidence).status).toBe("valid");
  });

  it("maps missing track + no terminal event to unknown, never active", async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, "legacy-run", [
      event("workflow.started"),
      event("step.started", { stepId: "work" }),
    ]);

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 10_000 } });
    expect(listed.entries[0]?.execution.state).toBe("unknown");
    expect(listed.entries[0]?.execution.state).not.toBe("active");
    expect(listed.entries[0]?.execution.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "missing-source",
    );
  });

  it("does not list staging infrastructure as run evidence", async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, ".staging/phantom-run", [event("workflow.started")], {
      track: { runId: "phantom-run", status: "running", ownerPid: process.pid },
    });
    await writeRun(runsRoot, "real-run", [event("workflow.started")], {
      track: { runId: "real-run", status: "running", ownerPid: process.pid },
    });

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 10_000 } });
    expect(listed.entries.map((entry) => entry.run.runId)).toEqual(["real-run"]);
    expect(listed.entries).toHaveLength(1);
  });

  it("lists a run named like the retired legacy staging pattern as evidence", async () => {
    const runsRoot = await makeRunsRoot();
    const runId = ".legit-run.tmp-abc123";
    await writeRun(runsRoot, runId, [event("workflow.started")], {
      track: { runId, status: "running", ownerPid: process.pid },
    });

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 10_000 } });
    expect(listed.entries.map((entry) => entry.run.runId)).toEqual([runId]);
  });

  it("maps cancelRequested without a terminal event to cancelled + a diagnostic", async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, "cancelled-run", [
      event("workflow.started"),
      event("workflow.cancelRequested"),
    ]);

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 10_000 } });
    expect(listed.entries[0]?.execution.state).toBe("cancelled");
    expect(listed.entries[0]?.execution.diagnostics.length).toBeGreaterThan(0);
  });

  it("lists 10k events without retaining the whole trail", async () => {
    const runsRoot = await makeRunsRoot();
    const events: Event[] = [event("workflow.started")];
    for (let index = 0; index < 9_998; index += 1) {
      events.push(event("step.progress", { payload: { message: `progress ${index}` } }));
    }
    events.push(event("workflow.completed"));
    await writeRun(runsRoot, "large-run", events);

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 20_000 } });
    expect(listed.entries[0]?.execution.state).toBe("completed");
    expect(listed.entries[0]?.execution.coverage).toBe("complete");
    expect(listed.bytesRead).toBeGreaterThan(0);
  });

  it("uses the last scanned event for timestamps even when it is not retained", async () => {
    const runsRoot = await makeRunsRoot();
    const track = { status: "running", ownerPid: 2_147_483_647 };
    await writeRun(
      runsRoot,
      "aaa-review-repro",
      [
        event("workflow.started", { timestamp: "2026-01-01T00:00:00.000Z" }),
        event("wait.started", {
          stepId: "approval",
          timestamp: "2026-01-01T00:01:00.000Z",
          payload: { waitId: "approve", branchId: "root" },
        }),
        event("step.progress", {
          stepId: "approval",
          timestamp: "2026-01-01T00:05:00.000Z",
          payload: { message: "later progress" },
        }),
      ],
      { track: { runId: "aaa-review-repro", ...track } },
    );
    await writeRun(
      runsRoot,
      "zzz-earlier-progress",
      [
        event("workflow.started", { timestamp: "2026-01-01T00:00:00.000Z" }),
        event("wait.started", {
          stepId: "approval",
          timestamp: "2026-01-01T00:01:00.000Z",
          payload: { waitId: "approve", branchId: "root" },
        }),
        event("step.progress", {
          stepId: "approval",
          timestamp: "2026-01-01T00:02:00.000Z",
          payload: { message: "earlier progress" },
        }),
      ],
      { track: { runId: "zzz-earlier-progress", ...track } },
    );

    const inspected = await inspectRunEvidence({
      runsRoot,
      project,
      runId: "aaa-review-repro",
    });
    expect(inspected.lastTimestamp).toBe("2026-01-01T00:05:00.000Z");

    const since = await listRunEvidence({
      runsRoot,
      project,
      since: "2026-01-01T00:03:00.000Z",
      limits: { deadlineMs: 10_000 },
    });
    expect(since.entries.map((entry) => entry.run.runId)).toEqual(["aaa-review-repro"]);

    const until = await listRunEvidence({
      runsRoot,
      project,
      until: "2026-01-01T00:03:00.000Z",
      limits: { deadlineMs: 10_000 },
    });
    expect(until.entries.map((entry) => entry.run.runId)).toEqual(["zzz-earlier-progress"]);

    const all = await listRunEvidence({
      runsRoot,
      project,
      limits: { deadlineMs: 10_000 },
    });
    expect(all.entries.map((entry) => entry.run.runId)).toEqual([
      "aaa-review-repro",
      "zzz-earlier-progress",
    ]);
  });

  it("reports partial coverage + budget-exceeded for a byte-capped trail", async () => {
    const runsRoot = await makeRunsRoot();
    const events: Event[] = [event("workflow.started")];
    for (let index = 0; index < 500; index += 1) {
      events.push(
        event("step.progress", {
          payload: { message: `progress ${index}`, body: "x".repeat(1024) },
        }),
      );
    }
    await writeRun(runsRoot, "capped-run", events);

    const listed = await listRunEvidence({
      runsRoot,
      project,
      limits: { maxEventBytesPerRun: 4096, deadlineMs: 10_000 },
    });
    expect(listed.entries[0]?.execution.coverage).toBe("partial");
    expect(listed.entries[0]?.execution.state).toBe("unknown");
    expect(listed.entries[0]?.execution.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "budget-exceeded",
    );
    expect(listed.bytesRead).toBeLessThanOrEqual(4096);
    expect(listed.coverage).toBe("partial");
  });

  it("keeps archive source links stable, manifest-only, and read-only", async () => {
    const runsRoot = await makeRunsRoot();
    const gzipBytes = Buffer.from("synthetic-archive-payload");
    const { gzPath, manifestPath } = await writeArchive(
      runsRoot,
      "archived-run",
      {
        schemaVersion: 1,
        runId: "archived-run",
        archivedAt: "2026-01-02T00:00:00.000Z",
        sourceRunDir: "/tmp/source",
        workflowId: "workflow-1",
        lastTimestamp: "2026-01-01T00:00:00.000Z",
        status: "failed",
      },
      gzipBytes,
    );
    const before = await snapshot(runsRoot);
    const run: RunEvidenceRunRef = {
      project,
      runId: "archived-run",
      workflowId: "workflow-1",
      identityQuality: "unknown",
    };

    const resolved = await resolveSourceLink({
      runsRoot,
      run,
      artifactPath: "state.json",
    });
    expect(resolved.storage).toBe("archived");
    expect(resolved.exists).toBe(true);
    expect(resolved.coverage).toBe("unknown");
    expect(resolved.sourceRef.artifactPath).toBe("state.json");
    expect(resolved.sourceRef.run).toEqual(run);
    expect(JSON.stringify(resolved)).not.toContain(".json.gz");

    const listed = await listRunEvidence({ runsRoot, project, limits: { deadlineMs: 10_000 } });
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.run.runId).toBe("archived-run");
    expect(listed.entries[0]?.execution.state).toBe("failed");
    expect(listed.entries[0]?.execution.storage).toBe("archived");
    expect(listed.entries[0]?.execution.coverage).toBe("unknown");
    expect(parseRunEvidence(listed.entries[0]).status).toBe("valid");

    const inspected = await inspectRunEvidence({
      runsRoot,
      project,
      runId: "archived-run",
    });
    expect(inspected.status).toBe("found");
    expect(inspected.evidence?.execution.storage).toBe("archived");

    const unavailable = await retrieveEvidence({
      runsRoot,
      sourceRef: sourceRef("archived-run", { artifactPath: "state.json" }),
    });
    expect(unavailable.status).toBe("unavailable");
    if (unavailable.status === "unavailable") {
      expect(unavailable.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "unsupported-source",
      );
    }

    expect((await readFile(gzPath)).equals(gzipBytes)).toBe(true);
    expect(await readFile(manifestPath, "utf8")).toContain('"archived-run"');
    expect(await snapshot(runsRoot)).toEqual(before);
  });

  it("bounds archive manifest discovery by maxRuns and reports partial coverage", async () => {
    const runsRoot = await makeRunsRoot();
    for (let index = 0; index < 50; index += 1) {
      await writeArchive(
        runsRoot,
        `archived-${index}`,
        {
          schemaVersion: 1,
          runId: `archived-${index}`,
          status: "completed",
          lastTimestamp: "2026-01-01T00:00:00.000Z",
          padding: "x".repeat(4096),
        },
        Buffer.from("payload"),
      );
    }

    const listed = await listRunEvidence({
      runsRoot,
      project,
      limits: { maxRuns: 1, deadlineMs: 10_000 },
    });
    expect(listed.scannedRuns).toBe(1);
    expect(listed.archivedRuns).toBe(1);
    expect(listed.entries).toHaveLength(1);
    expect(listed.truncated).toBe(true);
    expect(listed.coverage).toBe("partial");
    expect(listed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("budget-exceeded");
    expect(listed.bytesRead).toBeLessThan(8 * 1024);
  });

  it("checks the archive discovery deadline and abort before reading manifests", async () => {
    const runsRoot = await makeRunsRoot();
    for (let index = 0; index < 5; index += 1) {
      await writeArchive(
        runsRoot,
        `deadline-${index}`,
        {
          schemaVersion: 1,
          runId: `deadline-${index}`,
          status: "completed",
          padding: "x".repeat(4096),
        },
        Buffer.from("payload"),
      );
    }

    const deadline = await listRunEvidence({
      runsRoot,
      project,
      limits: { maxRuns: 10, deadlineMs: 0 },
    });
    expect(deadline.bytesRead).toBe(0);
    expect(deadline.scannedRuns).toBe(0);
    expect(deadline.entries).toHaveLength(0);
    expect(deadline.truncated).toBe(true);
    expect(deadline.coverage).toBe("partial");
    expect(deadline.diagnostics.map((diagnostic) => diagnostic.code)).toContain("budget-exceeded");

    const aborted = await listRunEvidence({
      runsRoot,
      project,
      signal: AbortSignal.abort(),
      limits: { maxRuns: 10, deadlineMs: 10_000 },
    });
    expect(aborted.bytesRead).toBe(0);
    expect(aborted.scannedRuns).toBe(0);
    expect(aborted.entries).toHaveLength(0);
    expect(aborted.truncated).toBe(true);
    expect(aborted.coverage).toBe("partial");
    expect(aborted.diagnostics.map((diagnostic) => diagnostic.code)).toContain("budget-exceeded");
  });

  it("returns a typed budget diagnostic when the query signal is already aborted", async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, "aborted-run", [event("workflow.started")]);

    const listed = await listRunEvidence({
      runsRoot,
      project,
      signal: AbortSignal.abort(),
      limits: { deadlineMs: 10_000 },
    });
    expect(listed.coverage).toBe("partial");
    expect(listed.truncated).toBe(true);
    expect(listed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("budget-exceeded");
  });

  it("returns a stable hot source ref and refuses unsafe artifact selectors", async () => {
    const runsRoot = await makeRunsRoot();
    await writeRun(runsRoot, "hot-run", [event("workflow.started", { id: "evt_original" })], {
      artifacts: { "state.json": JSON.stringify({ count: 1 }) },
    });
    const run: RunEvidenceRunRef = {
      project,
      runId: "hot-run",
      startedEventId: "evt_original",
      workflowId: "workflow-1",
      identityQuality: "explicit",
    };

    const artifact = await resolveSourceLink({
      runsRoot,
      run,
      artifactPath: "state.json",
    });
    expect(artifact.storage).toBe("hot");
    expect(artifact.exists).toBe(true);
    expect(artifact.sourceRef).toMatchObject({ artifactPath: "state.json" });

    const eventLink = await resolveSourceLink({
      runsRoot,
      run,
      eventId: "evt_original",
    });
    expect(eventLink.storage).toBe("hot");
    expect(eventLink.exists).toBe(true);
    expect(eventLink.sourceRef).toMatchObject({ eventId: "evt_original" });

    await expect(resolveSourceLink({ runsRoot, run, artifactPath: "../escape" })).rejects.toThrow(
      TypeError,
    );
  });

  it("keeps a failed terminal failure message out of default DTOs", async () => {
    const runsRoot = await makeRunsRoot();
    const canary = "CANARY-FAILURE-MESSAGE";
    const failureEvent = event("workflow.failed", {
      payload: { failure: { code: "step_failed", message: canary } },
    });
    await writeRun(runsRoot, "failed-run", [event("workflow.started"), failureEvent]);

    const inspected = await inspectRunEvidence({ runsRoot, project, runId: "failed-run" });
    expect(inspected.evidence?.execution.state).toBe("failed");
    expect(inspected.failure?.eventType).toBe("workflow.failed");
    expect(inspected.failure?.code).toBe("step_failed");
    expect(JSON.stringify(inspected)).not.toContain(canary);

    const actualExcerpt = await retrieveEvidence({
      runsRoot,
      sourceRef: {
        run: { project, runId: "failed-run", identityQuality: "explicit" },
        eventId: failureEvent.id,
      },
    });
    expect(actualExcerpt.status).toBe("ok");
    if (actualExcerpt.status === "ok") {
      expect(actualExcerpt.excerpt).toContain("step_failed");
    }
  });
});
