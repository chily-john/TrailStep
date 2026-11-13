import { mkdir, mkdtemp, open, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Event } from "../../contracts/events/event.types.js";
import { resolveRunDirectory } from "../../runs/run-directory.js";
import { listRunSummaries } from "../runs/run-summaries.js";
import {
  appendEvent,
  atomicWriteJson,
  createRunDirectory,
  readJsonStateArtifact,
  readRunEvents,
  readRunEventsSince,
  readRunState,
  TRAILSTEP_GITIGNORE_BODY,
  writeJsonStateArtifact,
  writeRunState,
} from "./run-storage.js";

describe("run storage", () => {
  it("appendEvent appends newline-delimited events without rewriting previous lines", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "event-run" });

    await appendEvent(runDir, {
      id: "event-1",
      runId: "event-run",
      workflowId: "append-workflow",
      type: "workflow.started",
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: "v0",
      payload: { input: { value: 1 } },
    });
    await appendEvent(runDir, {
      id: "event-2",
      runId: "event-run",
      workflowId: "append-workflow",
      type: "workflow.completed",
      timestamp: "2026-01-01T00:00:01.000Z",
      schemaVersion: "v0",
      payload: { output: { value: 2 } },
    });

    const lines = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as { readonly id: string })).toEqual([
      expect.objectContaining({ id: "event-1" }),
      expect.objectContaining({ id: "event-2" }),
    ]);
  });

  it("readRunEvents ignores one unparseable trailing line", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "partial-run" });

    await appendEvent(runDir, {
      id: "event-1",
      runId: "partial-run",
      workflowId: "partial-workflow",
      type: "workflow.started",
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: "v0",
      payload: { input: { value: 1 } },
    });
    await writeFile(
      join(runDir, "events.jsonl"),
      '{"id":"event-1","runId":"partial-run","workflowId":"partial-workflow","type":"workflow.started","timestamp":"2026-01-01T00:00:00.000Z","schemaVersion":"v0","payload":{"input":{"value":1}}}\n{"partial"',
      "utf8",
    );

    await expect(readRunEvents(runDir)).resolves.toEqual([
      expect.objectContaining({ id: "event-1", type: "workflow.started" }),
    ]);
  });

  it("readRunEvents skips a torn middle line and returns the rest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "torn-middle-run" });
    const first = makeEvent("workflow.started");
    const second = makeEvent("step.started");
    const third = makeEvent("workflow.completed");
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(first)}\n{"id":"e2","type":"step.sta\n${JSON.stringify(second)}\n${JSON.stringify(third)}\n`,
      "utf8",
    );

    const reported: string[] = [];
    const events = await readRunEvents(runDir, {
      report: (message) => reported.push(message),
    });

    expect(events.map((event) => event.id)).toEqual([first.id, second.id, third.id]);
    expect(reported).toHaveLength(1);
    expect(reported.join("\n")).toContain("line 2");
  });

  it("readRunEvents skips a line that parses as JSON but is not event-shaped", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "non-event-line-run" });
    const first = makeEvent("workflow.started");
    const second = makeEvent("workflow.completed");
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(first)}\n{"hello":"world"}\n${JSON.stringify(second)}\n`,
      "utf8",
    );

    const reported: string[] = [];
    const events = await readRunEvents(runDir, {
      report: (message) => reported.push(message),
    });

    expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(reported.join("\n")).toContain("Unexpected event shape");
  });

  it("readRunEvents still throws resume_target_not_found when the trail is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const missingRunDir = join(cwd, "missing-run");

    await expect(readRunEvents(missingRunDir)).rejects.toMatchObject({
      failure: {
        code: "resume_target_not_found",
        details: { runDir: missingRunDir, causeCode: "ENOENT" },
      },
    });
  });

  it("readRunEvents works with no options argument", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "no-options-run" });
    const event = makeEvent("workflow.started");
    await appendEvent(runDir, event);

    await expect(readRunEvents(runDir)).resolves.toEqual([event]);
  });

  it("serializes concurrent appendEvent calls into a fully parseable trail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "concurrent-append-run" });
    const events = Array.from({ length: 50 }, (_, index) => ({
      ...makeEvent("step.progress"),
      id: `evt_concurrent_${index}`,
      payload: { big: "x".repeat(100_000) },
    }));

    await Promise.all(events.map((event) => appendEvent(runDir, event)));

    const trail = await readFile(join(runDir, "events.jsonl"), "utf8");
    expect(trail.split("\n").filter((line) => line.length > 0)).toHaveLength(50);

    const readBack = await readRunEvents(runDir);
    expect(readBack.map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it("writes initial track state before returning a newly created run directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    const { runDir } = await createRunDirectory({
      cwd,
      runName: "initial-track-run",
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    const track = JSON.parse(await readFile(join(runDir, "track.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(track).toEqual({ runId: "initial-track-run", status: "running", ownerPid: process.pid });
  });

  it("removes a new run directory when initial track state cannot be written", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await expect(
      createRunDirectory({
        cwd,
        runName: "broken-track-run",
        initialTrackState: ({ runId }) => ({ runId, ownerPid: 1n }),
      }),
    ).rejects.toMatchObject({ failure: { code: "run_track_initialization_failed" } });
    await expect(stat(join(cwd, ".trailstep", "runs", "broken-track-run"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(join(cwd, ".trailstep", "runs"))).resolves.toEqual([]);
  });

  it("preserves the underlying cause code when track initialization fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await expect(
      createRunDirectory({
        cwd,
        runName: "cause-code-run",
        initialTrackState: () => {
          throw Object.assign(new Error("track write denied"), { code: "EACCES" });
        },
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "run_track_initialization_failed",
        details: { causeCode: "EACCES" },
      },
    });
    await expect(readdir(join(cwd, ".trailstep", "runs"))).resolves.toEqual([]);
  });

  it("never exposes a run directory before its track is readable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runsRoot = join(cwd, ".trailstep", "runs");
    const runName = "atomic-track-run";
    const runDir = join(runsRoot, runName);

    let releaseTrack!: () => void;
    const trackGate = new Promise<void>((resolve) => {
      releaseTrack = resolve;
    });
    let markTrackFactoryStarted!: () => void;
    const trackFactoryStarted = new Promise<void>((resolve) => {
      markTrackFactoryStarted = resolve;
    });
    let markAbsentSeen!: () => void;
    const absentSeen = new Promise<void>((resolve) => {
      markAbsentSeen = resolve;
    });
    let markTrackSeen!: () => void;
    const trackSeen = new Promise<void>((resolve) => {
      markTrackSeen = resolve;
    });

    let done = false;
    const observations: ("absent" | "track" | "trackless")[] = [];
    const observer = (async () => {
      while (!done) {
        try {
          await readdir(runDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            observations.push("absent");
            markAbsentSeen();
            await new Promise<void>((resolve) => setImmediate(resolve));
            continue;
          }
          throw error;
        }

        try {
          const track = JSON.parse(await readFile(join(runDir, "track.json"), "utf8")) as {
            readonly runId?: unknown;
          };
          if (track.runId === runName) {
            observations.push("track");
            markTrackSeen();
          } else {
            observations.push("trackless");
          }
        } catch {
          observations.push("trackless");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();

    const creation = createRunDirectory({
      cwd,
      runName,
      initialTrackState: async ({ runId }) => {
        markTrackFactoryStarted();
        await trackGate;
        return { runId, status: "running", ownerPid: process.pid };
      },
    });

    await trackFactoryStarted;
    await absentSeen;
    releaseTrack();

    let created: { readonly runId: string; readonly runDir: string };
    try {
      created = await creation;
      await trackSeen;
    } finally {
      done = true;
    }
    await observer;

    expect(created.runDir).toBe(runDir);
    expect(observations).toContain("track");
    expect(observations).not.toContain("trackless");
    await expect(readFile(join(created.runDir, "track.json"), "utf8")).resolves.toContain(
      `"runId": "${runName}"`,
    );
  });

  it("publishes a run directory with no staging marker or staging residue", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runsRoot = join(cwd, ".trailstep", "runs");

    const created = await createRunDirectory({
      cwd,
      runName: "clean-publish-run",
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    const runEntries = await readdir(created.runDir);
    expect(runEntries).toEqual(["track.json"]);
    expect(runEntries).not.toContain(".trailstep-staging");
    expect(created.runDir).not.toContain(".tmp-");

    const runsRootEntries = await readdir(runsRoot);
    expect(runsRootEntries).toContain("clean-publish-run");
    expect(runsRootEntries.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps stale staging invisible as a run and reclaims it on the next creation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runsRoot = join(cwd, ".trailstep", "runs");
    const stagingDir = join(runsRoot, ".staging", "run-stale-staging");
    await mkdir(stagingDir, { recursive: true });
    const old = new Date(0);
    await utimes(stagingDir, old, old);

    // Staging is infrastructure, never a phantom run.
    await expect(listRunSummaries({ cwd, runsRoot })).resolves.toEqual([]);

    await createRunDirectory({
      cwd,
      runName: "after-crash-run",
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    await expect(stat(stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
    const summaries = await listRunSummaries({ cwd, runsRoot });
    expect(summaries.map((summary) => summary.runId)).toEqual(["after-crash-run"]);
  });

  it("never reclaims an aged staging entry that lacks the run- prefix", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runsRoot = join(cwd, ".trailstep", "runs");
    const foreignDir = join(runsRoot, ".staging", "operator-notes");
    const notePath = join(foreignDir, "note.txt");
    await mkdir(foreignDir, { recursive: true });
    await writeFile(notePath, "not ours\n", "utf8");
    const old = new Date(0);
    await utimes(notePath, old, old);
    await utimes(foreignDir, old, old);

    await createRunDirectory({
      cwd,
      runName: "after-foreign-staging-run",
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    // The entry holds no run artifacts, so only the mkdtemp `run-` naming rule
    // protects it. The sibling artifact-bearing test covers the other rule.
    await expect(stat(foreignDir)).resolves.toBeDefined();
    await expect(readFile(notePath, "utf8")).resolves.toBe("not ours\n");
  });

  it("never reclaims a run-* staging candidate that holds run artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runsRoot = join(cwd, ".trailstep", "runs");
    const candidateDir = join(runsRoot, ".staging", "run-artifact-bearing");
    const eventsPath = join(candidateDir, "events.jsonl");
    const trackPath = join(candidateDir, "track.json");
    await mkdir(candidateDir, { recursive: true });
    await writeFile(
      eventsPath,
      `${JSON.stringify({ ...makeEvent("workflow.started"), runId: "artifact-bearing" })}\n`,
      "utf8",
    );
    await writeFile(trackPath, `${JSON.stringify({ runId: "artifact-bearing" })}\n`, "utf8");
    const old = new Date(0);
    await utimes(candidateDir, old, old);

    // Defence in depth: a run artifact inside the candidate blocks deletion even
    // though its `run-` name matches the staging rule; it also stays invisible
    // to run listings.
    await expect(listRunSummaries({ cwd, runsRoot })).resolves.toEqual([]);
    await createRunDirectory({
      cwd,
      runName: "after-defence-in-depth-run",
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    await expect(readFile(eventsPath, "utf8")).resolves.toContain('"type":"workflow.started"');
    await expect(readFile(trackPath, "utf8")).resolves.toContain('"runId":"artifact-bearing"');
  });

  it("never prunes a legacy run stored at the .staging path and keeps it readable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runsRoot = join(cwd, ".trailstep", "runs");
    const legacyRunDir = join(runsRoot, ".staging");
    const stepsDir = join(legacyRunDir, "steps");
    const stepDir = join(stepsDir, "0001-review");
    const eventsPath = join(legacyRunDir, "events.jsonl");
    const trackPath = join(legacyRunDir, "track.json");
    const outputPath = join(stepDir, "output.md");
    const runNamedChildDir = join(legacyRunDir, "run-legacy-child");
    const runNamedChildPath = join(runNamedChildDir, "output.txt");

    await mkdir(stepDir, { recursive: true });
    await mkdir(runNamedChildDir, { recursive: true });
    await writeFile(
      eventsPath,
      `${JSON.stringify({ ...makeEvent("workflow.started"), runId: "legacy-staging-run" })}\n`,
      "utf8",
    );
    await writeFile(
      trackPath,
      `${JSON.stringify({ runId: "legacy-staging-run", status: "completed", branches: [] })}\n`,
      "utf8",
    );
    await writeFile(outputPath, "legacy step output\n", "utf8");
    await writeFile(runNamedChildPath, "legacy child output\n", "utf8");
    const old = new Date(0);
    await utimes(outputPath, old, old);
    await utimes(runNamedChildPath, old, old);
    await utimes(stepDir, old, old);
    await utimes(stepsDir, old, old);
    await utimes(runNamedChildDir, old, old);
    await utimes(legacyRunDir, old, old);

    // Reserved infrastructure stays out of run listings by design.
    await expect(listRunSummaries({ cwd, runsRoot })).resolves.toEqual([]);

    await createRunDirectory({
      cwd,
      runName: "after-legacy-staging-run",
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    // The review fixture: a three-day-old steps subtree must survive the next
    // creation intact, together with the legacy events and track.
    await expect(readFile(eventsPath, "utf8")).resolves.toContain('"runId":"legacy-staging-run"');
    await expect(readFile(trackPath, "utf8")).resolves.toContain('"runId":"legacy-staging-run"');
    await expect(readFile(outputPath, "utf8")).resolves.toBe("legacy step output\n");
    // Even a staging-looking child of a legacy run is run content, not ours.
    await expect(readFile(runNamedChildPath, "utf8")).resolves.toBe("legacy child output\n");

    // An operator reaches the legacy run by explicit path with read-only
    // inspection; the reserved name only blocks mutating resolution.
    const resolved = await resolveRunDirectory(legacyRunDir, { cwd }, { access: "inspect" });
    expect(resolved.runDir).toBe(legacyRunDir);
    await expect(readRunEvents(resolved.runDir)).resolves.toEqual([
      expect.objectContaining({ runId: "legacy-staging-run" }),
    ]);

    const summaries = await listRunSummaries({ cwd, runsRoot });
    expect(summaries.map((summary) => summary.runId)).toEqual(["after-legacy-staging-run"]);
  });

  it("treats a run named like the retired legacy staging pattern as a normal run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const legacyLookingName = ".legit-run.tmp-abc123";

    const created = await createRunDirectory({
      cwd,
      runName: legacyLookingName,
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });
    // Backdate the run so the retired legacy reclaimer would have deleted it.
    const old = new Date(0);
    await utimes(created.runDir, old, old);
    await createRunDirectory({
      cwd,
      runName: "another-run",
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    await expect(stat(created.runDir)).resolves.toBeDefined();
    const summaries = await listRunSummaries({ cwd });
    expect(summaries.map((summary) => summary.runId)).toContain(legacyLookingName);
  });

  it.each([
    ".staging",
    ".archive",
    ".STAGING",
    ".Archive",
    ".staging.",
    ".staging ",
    ".archive.",
    ".archive ",
  ])("rejects the reserved run name %s before creating anything", async (runName) => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await expect(createRunDirectory({ cwd, runName })).rejects.toMatchObject({
      failure: { code: "run_name_reserved" },
    });
    await expect(stat(join(cwd, ".trailstep", "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([".", "..", "...", ". ", ".. ", ". .", " ..."])(
    "rejects the runs-root alias name %j before creating anything",
    async (runName) => {
      const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

      await expect(createRunDirectory({ cwd, runName })).rejects.toMatchObject({
        failure: { code: "run_name_reserved" },
      });
      await expect(stat(join(cwd, ".trailstep", "runs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("still creates a dotted near-miss name that is not reserved", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runName = ".near-miss-run";

    const created = await createRunDirectory({
      cwd,
      runName,
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    expect(created.runId).toBe(runName);
    await expect(stat(join(created.runDir, "track.json"))).resolves.toBeDefined();
  });

  it.each([".staging-run", ".archive-run", ".stagingx", ".archivex"])(
    "still creates the reserved-looking near-miss name %s",
    async (runName) => {
      const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

      const created = await createRunDirectory({
        cwd,
        runName,
        initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
      });

      expect(created.runId).toBe(runName);
      await expect(stat(created.runDir)).resolves.toBeDefined();
    },
  );

  it("rejects an initial track that does not record the created run id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await expect(
      createRunDirectory({
        cwd,
        runName: "foreign-track-run",
        initialTrackState: () => ({ runId: "someone-else", status: "running" }),
      }),
    ).rejects.toMatchObject({ failure: { code: "run_track_initialization_failed" } });
    await expect(readdir(join(cwd, ".trailstep", "runs"))).resolves.toEqual([]);
  });

  it("takes the next suffix when the published track belongs to another run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runsRoot = join(cwd, ".trailstep", "runs");
    let calls = 0;

    const created = await createRunDirectory({
      cwd,
      runName: "contested-track-run",
      initialTrackState: ({ runId }) => {
        calls += 1;
        if (calls === 1) {
          // Simulate a concurrent writer replacing the published track after
          // our rename: the on-disk track records a different run id even
          // though the in-memory value validated before publication.
          return {
            runId,
            status: "running",
            toJSON: () => ({ runId: "other-owner", status: "running" }),
          };
        }
        return { runId, status: "running", ownerPid: process.pid };
      },
    });

    expect(created.runId).toBe("contested-track-run-2");
    // The contested directory is left for its track's owner, never deleted.
    await expect(
      readFile(join(runsRoot, "contested-track-run", "track.json"), "utf8"),
    ).resolves.toContain('"runId": "other-owner"');
    await expect(readFile(join(created.runDir, "track.json"), "utf8")).resolves.toContain(
      '"runId": "contested-track-run-2"',
    );
  });

  it("creates a long but legal run name without embedding it in the staging path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const runName = "r".repeat(244);

    const created = await createRunDirectory({
      cwd,
      runName,
      initialTrackState: ({ runId }) => ({ runId, status: "running", ownerPid: process.pid }),
    });

    expect(created.runId).toBe(runName);
    expect(basename(created.runDir)).toBe(runName);
    await expect(stat(join(created.runDir, "track.json"))).resolves.toBeDefined();
  });

  it("rejects run names that would escape the runs root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await expect(createRunDirectory({ cwd, runName: "../escape" })).rejects.toMatchObject({
      failure: { code: "run_name_invalid" },
    });
  });

  it("creates a .trailstep/.gitignore that ignores run artifacts but not the committed config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await createRunDirectory({ cwd, runName: "first-run" });

    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    const contents = await readFile(gitignorePath, "utf8");
    expect(contents).toBe(TRAILSTEP_GITIGNORE_BODY);
    expect(contents).toContain("runs/");
    expect(contents).toContain("config-local.json");
    expect(contents.split("\n")).not.toContain("*");
    expect(contents).not.toContain("!config.json");
  });

  it("repairs the legacy blanket .gitignore body in place", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    await writeFile(gitignorePath, "*\n!.gitignore\n", "utf8");

    await createRunDirectory({ cwd, runName: "legacy-gitignore-run" });

    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(TRAILSTEP_GITIGNORE_BODY);
  });

  it("never rewrites a hand-edited .gitignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    await mkdir(join(cwd, ".trailstep"), { recursive: true });
    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    // This repo's hand-fixed body: not the legacy generated one, so it is the user's.
    const handEdited = "*\n!.gitignore\n!config.json\n";
    await writeFile(gitignorePath, handEdited, "utf8");

    await createRunDirectory({ cwd, runName: "hand-edited-gitignore-run" });

    await expect(readFile(gitignorePath, "utf8")).resolves.toBe(handEdited);
  });

  it("does not throw or corrupt the .gitignore file on a second run in the same cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));

    await createRunDirectory({ cwd, runName: "first-run" });
    const gitignorePath = join(cwd, ".trailstep", ".gitignore");
    const firstContents = await readFile(gitignorePath, "utf8");

    await expect(createRunDirectory({ cwd, runName: "second-run" })).resolves.toMatchObject({
      runId: "second-run",
    });

    const secondContents = await readFile(gitignorePath, "utf8");
    expect(secondContents).toBe(firstContents);
    expect(secondContents).toBe(TRAILSTEP_GITIGNORE_BODY);
  });

  it("persists run state as state.json and reads it from a second helper call", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const { runDir } = await createRunDirectory({ cwd, runName: "state-run" });

    await expect(readRunState(runDir)).resolves.toEqual({});

    await writeRunState(runDir, { count: { value: 1 } });

    await expect(readRunState(runDir)).resolves.toEqual({ count: { value: 1 } });
    await expect(readFile(join(runDir, "state.json"), "utf8")).resolves.toBe(
      `${JSON.stringify({ count: { value: 1 } }, null, 2)}\n`,
    );
  });

  it("atomicWriteJson leaves no *.tmp file behind on success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "state.json");

    await atomicWriteJson(target, { hello: "world", nested: { n: 1 } });

    await expect(readFile(target, "utf8")).resolves.toBe(
      `${JSON.stringify({ hello: "world", nested: { n: 1 } }, null, 2)}\n`,
    );
    expect((await readdir(dir)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("atomicWriteJson rejects and removes its tmp file when the rename cannot complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "blocked.json");
    // Occupy the target with a directory so the final same-directory rename
    // must fail after the tmp file has already been written.
    await mkdir(target);

    await expect(atomicWriteJson(target, { a: 1 })).rejects.toBeInstanceOf(Error);

    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("writeJsonStateArtifact round-trips through readJsonStateArtifact without tmp residue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "state.json");
    const state = { count: { value: 3 }, flag: true, list: [1, "two"] };

    await writeJsonStateArtifact(target, state);

    await expect(readJsonStateArtifact(target)).resolves.toEqual(state);
    await expect(readJsonStateArtifact(join(dir, "missing.json"))).resolves.toEqual({});
    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("atomicWriteJson serializes concurrent writes to one target and leaves no tmp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-"));
    const target = join(dir, "track.json");
    await atomicWriteJson(target, { writer: 0 });

    // Overlapping replace-renames of one target fail with EPERM on Windows;
    // the writes must be serialized so every caller succeeds and exactly one
    // complete document remains.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => atomicWriteJson(target, { writer: index + 1 })),
    );

    await expect(readJsonStateArtifact(target)).resolves.toEqual({
      writer: expect.any(Number),
    });
    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("atomicWriteJson succeeds while a reader briefly holds the target open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trailstep-core-atomic-open-"));
    const target = join(dir, "answer.json");
    await atomicWriteJson(target, { round: 0 });

    // On Windows a replace-rename fails with EPERM while any other handle has
    // the target open. The runtime's wait poller and the dashboard both read
    // the answer file while it is being written, so the write has to survive a
    // concurrent reader instead of failing the whole command.
    const handle = await open(target, "r");
    const write = atomicWriteJson(target, { round: 1 });
    // The reader releases the file once its read completes.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await handle.close();

    await expect(write).resolves.toBeUndefined();
    await expect(readJsonStateArtifact(target)).resolves.toEqual({ round: 1 });
    expect((await readdir(dir)).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it("readRunEventsSince returns complete event lines and advances the cursor", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const firstEvent = makeEvent("workflow.started");
    const secondEvent = makeEvent("step.started");
    const expectedContents = `${JSON.stringify(firstEvent)}\n${JSON.stringify(secondEvent)}\n`;
    await writeFile(eventsFile, expectedContents, "utf8");

    const first = await readRunEventsSince(eventsFile, 0);
    expect(first.entries.map((entry) => entry.event.type)).toEqual([
      "workflow.started",
      "step.started",
    ]);
    expect(first.offset).toBe(Buffer.byteLength(expectedContents, "utf8"));

    const second = await readRunEventsSince(eventsFile, first.offset);
    expect(second.entries).toEqual([]);
    expect(second.offset).toBe(first.offset);
  });

  it("readRunEventsSince short-circuits when the trail has not grown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const contents = `${JSON.stringify(makeEvent("workflow.started"))}\n`;
    await writeFile(eventsFile, contents, "utf8");

    const size = Buffer.byteLength(contents, "utf8");
    const read = await readRunEventsSince(eventsFile, size);

    // No new bytes: nothing to parse and no full-file text, which is the
    // observable contract that keeps a 50 ms long-poll off the whole trail.
    expect(read.entries).toEqual([]);
    expect(read.offset).toBe(size);
    expect(read.text).toBe("");
  });

  it("readRunEventsSince restarts from 0 when the cursor is past the file size", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const contents = `${JSON.stringify(makeEvent("workflow.started"))}\n`;
    await writeFile(eventsFile, contents, "utf8");

    const read = await readRunEventsSince(eventsFile, 10_000);

    expect(read.entries.map((entry) => entry.event.type)).toEqual(["workflow.started"]);
    expect(read.offset).toBe(Buffer.byteLength(contents, "utf8"));
  });

  it("readRunEventsSince leaves a partial trailing line for the next read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    const firstEvent = makeEvent("workflow.started");
    await writeFile(eventsFile, `${JSON.stringify(firstEvent)}\n{"partial"`, "utf8");

    const read = await readRunEventsSince(eventsFile, 0);
    expect(read.entries.map((entry) => entry.event.type)).toEqual(["workflow.started"]);
    expect(read.offset).toBe(Buffer.byteLength(`${JSON.stringify(firstEvent)}\n`, "utf8"));
  });

  it("readRunEventsSince reports and skips malformed or non-event lines", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "trailstep-core-run-storage-"));
    const eventsFile = join(cwd, "events.jsonl");
    await writeFile(
      eventsFile,
      `${JSON.stringify(makeEvent("workflow.started"))}\n${JSON.stringify({ hello: "world" })}\n{not json}\n${JSON.stringify(makeEvent("step.started"))}\n`,
      "utf8",
    );

    const errors: string[] = [];
    const read = await readRunEventsSince(eventsFile, 0, {
      report: (message) => errors.push(message),
    });

    expect(read.entries.map((entry) => entry.event.type)).toEqual([
      "workflow.started",
      "step.started",
    ]);
    expect(errors.join("\n")).toContain("Unexpected event shape");
    expect(errors.join("\n")).toContain("Unable to parse event JSONL");
  });
});

function makeEvent(type: Event["type"]): Event {
  return {
    id: `evt_${type}`,
    runId: "run-storage-test",
    workflowId: "workflow-storage-test",
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: "v0",
    payload: {},
  };
}
