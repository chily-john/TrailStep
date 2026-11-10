import { describe, expect, it } from "vitest";
import {
  isSafeEvidenceArtifactPath,
  parseRunEvidence,
  runEvidenceSchema,
} from "./evidence.schema.js";
import type { EvidenceSourceRef, RunEvidence } from "./evidence.types.js";

function minimalEvidence(): Record<string, unknown> {
  return {
    kind: "trailstep.run-evidence",
    schemaVersion: 1,
    observedAt: "2026-11-10T18:00:00.000Z",
    projectorRevision: "1",
    run: {
      project: { kind: "explicit", key: "trailstep" },
      runId: "run-1",
      startedEventId: "evt-original",
      workflowId: "workflow-a",
      identityQuality: "explicit",
    },
    execution: { state: "completed", storage: "hot", coverage: "complete", diagnostics: [] },
  };
}

function sourceRun(): Record<string, unknown> {
  return {
    project: { kind: "explicit", key: "trailstep" },
    runId: "run-1",
    startedEventId: "evt-original",
    workflowId: "workflow-a",
    identityQuality: "explicit",
  };
}

describe("parseRunEvidence", () => {
  it("accepts a minimal valid V1 record", () => {
    const result = parseRunEvidence(minimalEvidence());
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.evidence.kind).toBe("trailstep.run-evidence");
      expect(result.evidence.schemaVersion).toBe(1);
      expect(result.evidence.run.startedEventId).toBe("evt-original");
      expect(result.evidence.execution).toEqual({
        state: "completed",
        storage: "hot",
        coverage: "complete",
        diagnostics: [],
      });
    }
    expect(runEvidenceSchema.validate(minimalEvidence())).toBe(true);
  });

  it("tolerates additive unknown keys but reconstructs allowlisted output", () => {
    const input = minimalEvidence();
    input.futureField = { anything: true };
    (input.run as Record<string, unknown>).extra = "drop-me";
    (input.execution as Record<string, unknown>).extra = 42;

    const result = parseRunEvidence(input);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect("futureField" in result.evidence).toBe(false);
      expect("extra" in (result.evidence.run as unknown as Record<string, unknown>)).toBe(false);
      expect("extra" in (result.evidence.execution as unknown as Record<string, unknown>)).toBe(
        false,
      );
      expect(Object.keys(result.evidence).sort()).toEqual(
        ["execution", "kind", "observedAt", "projectorRevision", "run", "schemaVersion"].sort(),
      );
    }
  });

  it("distinguishes future versions as unsupported, malformed V1 as malformed", () => {
    const future = { ...minimalEvidence(), schemaVersion: 2 };
    const futureResult = parseRunEvidence(future);
    expect(futureResult.status).toBe("unsupported-version");
    if (futureResult.status === "unsupported-version") {
      expect(futureResult.schemaVersion).toBe(2);
      expect(futureResult.diagnostics[0]?.code).toBe("unsupported-version");
    }

    const otherKind = { ...minimalEvidence(), kind: "trailstep.other" };
    expect(parseRunEvidence(otherKind).status).toBe("unsupported-version");

    const malformed = minimalEvidence();
    delete (malformed.run as Record<string, unknown>).runId;
    const malformedResult = parseRunEvidence(malformed);
    expect(malformedResult.status).toBe("malformed");
    if (malformedResult.status === "malformed") {
      expect(malformedResult.diagnostics.length).toBeGreaterThan(0);
    }

    expect(parseRunEvidence(null).status).toBe("malformed");
    expect(parseRunEvidence({ kind: "trailstep.run-evidence" }).status).toBe("malformed");
  });

  it("rejects malformed envelope fields and bad observation values", () => {
    const badDate = { ...minimalEvidence(), observedAt: "not-a-date" };
    expect(parseRunEvidence(badDate).status).toBe("malformed");

    const badState = minimalEvidence();
    (badState.execution as Record<string, unknown>).state = "exploded";
    expect(parseRunEvidence(badState).status).toBe("malformed");

    const missingExecution = minimalEvidence();
    delete missingExecution.execution;
    expect(parseRunEvidence(missingExecution).status).toBe("malformed");

    const unknownDiagnostic = minimalEvidence();
    (unknownDiagnostic.execution as Record<string, unknown>).diagnostics = [{ code: "not-a-code" }];
    expect(parseRunEvidence(unknownDiagnostic).status).toBe("malformed");
  });

  it("keeps a measured zero distinct from unknown", () => {
    const zero = minimalEvidence();
    zero.usage = { state: "known", value: 0 };
    const zeroResult = parseRunEvidence(zero);
    expect(zeroResult.status).toBe("valid");
    if (zeroResult.status === "valid") {
      expect(zeroResult.evidence.usage).toEqual({ state: "known", value: 0 });
    }

    const unknown = minimalEvidence();
    unknown.usage = { state: "unknown", reasons: ["missing"] };
    const unknownResult = parseRunEvidence(unknown);
    expect(unknownResult.status).toBe("valid");
    if (unknownResult.status === "valid") {
      expect(unknownResult.evidence.usage).toEqual({ state: "unknown", reasons: ["missing"] });
      expect(unknownResult.evidence.usage).not.toEqual(
        zeroResult.status === "valid" ? zeroResult.evidence.usage : undefined,
      );
    }

    const badUnknown = minimalEvidence();
    badUnknown.usage = { state: "unknown", reasons: [] };
    expect(parseRunEvidence(badUnknown).status).toBe("malformed");

    const negative = minimalEvidence();
    negative.usage = { state: "known", value: -1 };
    expect(parseRunEvidence(negative).status).toBe("malformed");
  });

  it("accepts partial coverage without implying a verdict", () => {
    const input = minimalEvidence();
    input.execution = {
      state: "failed",
      storage: "archived",
      coverage: "partial",
      diagnostics: [{ code: "partial-coverage", message: "session copy unavailable" }],
    };
    input.usage = { state: "partial", value: 12, reasons: ["missing"] };

    const result = parseRunEvidence(input);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.evidence.execution.coverage).toBe("partial");
      expect(result.evidence.usage).toEqual({ state: "partial", value: 12, reasons: ["missing"] });
    }
  });

  it("accepts legacy local identity without fabricating a start event", () => {
    const input = minimalEvidence();
    input.run = {
      project: { kind: "local", rootRef: "canonical-root" },
      runId: "run-legacy",
      identityQuality: "legacy-ambiguous",
    };
    const result = parseRunEvidence(input);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.evidence.run.startedEventId).toBeUndefined();
      expect(result.evidence.run.identityQuality).toBe("legacy-ambiguous");
    }
  });

  it("keeps the same runId distinct across projects", () => {
    const first = minimalEvidence();
    (first.run as Record<string, unknown>).project = {
      kind: "explicit",
      key: "team-alpha/app",
    };
    const second = minimalEvidence();
    (second.run as Record<string, unknown>).project = {
      kind: "explicit",
      key: "team-beta/app",
    };

    const firstResult = parseRunEvidence(first);
    const secondResult = parseRunEvidence(second);
    expect(firstResult.status).toBe("valid");
    expect(secondResult.status).toBe("valid");
    if (firstResult.status === "valid" && secondResult.status === "valid") {
      expect(firstResult.evidence.run.runId).toBe(secondResult.evidence.run.runId);
      expect(firstResult.evidence.run.project).not.toEqual(secondResult.evidence.run.project);
    }
  });

  it("keeps the original start identity stable across re-observation", () => {
    const first = minimalEvidence();
    const second = { ...minimalEvidence(), observedAt: "2026-11-10T19:00:00.000Z" };

    const firstResult = parseRunEvidence(first);
    const secondResult = parseRunEvidence(second);
    expect(firstResult.status).toBe("valid");
    expect(secondResult.status).toBe("valid");
    if (firstResult.status === "valid" && secondResult.status === "valid") {
      expect(firstResult.evidence.run.runId).toBe(secondResult.evidence.run.runId);
      expect(firstResult.evidence.run.startedEventId).toBe("evt-original");
      expect(secondResult.evidence.run.startedEventId).toBe("evt-original");
      expect(firstResult.evidence.observedAt).not.toBe(secondResult.evidence.observedAt);
    }
  });

  it("requires run references but allows missing inspected fields to stay absent", () => {
    const input = minimalEvidence();
    input.run = { runId: "run-1", identityQuality: "unknown" };
    expect(parseRunEvidence(input).status).toBe("malformed");
  });

  it("treats execution, storage, and coverage as orthogonal", () => {
    const states = ["active", "waiting", "completed", "failed", "cancelled", "stale", "unknown"];
    const storages = ["hot", "archived", "missing", "unreadable"];
    for (const state of states) {
      for (const storage of storages) {
        const input = minimalEvidence();
        input.execution = { state, storage, coverage: "unknown", diagnostics: [] };
        expect(parseRunEvidence(input).status).toBe("valid");
      }
    }
  });
});

describe("safe artifact references", () => {
  it("accepts safe relative artifact paths and event references", () => {
    for (const path of [
      "events.jsonl",
      "steps/0001-work/output.json",
      "reviews/source-key/review-1/report.json",
      "a-b_c.d/e.json",
    ]) {
      expect(isSafeEvidenceArtifactPath(path)).toBe(true);
    }

    const input = minimalEvidence();
    input.linkedArtifacts = [
      { label: "report", source: { run: sourceRun(), artifactPath: "reviews/k/r1/report.json" } },
      { source: { run: sourceRun(), eventId: "evt-original", digest: "sha256:abc123" } },
    ];
    const result = parseRunEvidence(input);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.evidence.linkedArtifacts).toHaveLength(2);
    }
  });

  it("rejects traversal, absolute, drive, backslash, encoding, and empty-segment paths", () => {
    for (const path of [
      "../escape",
      "a/../../escape",
      "a/../b",
      "a/./b",
      "/absolute/path",
      "C:\\Windows\\Temp",
      "C:/Windows",
      "a\\b",
      "a//b",
      "a/b/",
      "a/%2fb",
      "a/%2e%2e/b",
      "",
      ".",
      "..",
      "a/C:/b",
    ]) {
      expect(isSafeEvidenceArtifactPath(path), path).toBe(false);
    }
  });

  it("rejects linked-artifact records with unsafe paths", () => {
    for (const artifactPath of ["../escape", "/abs", "a\\b", "C:\\win", "a//b"]) {
      const input = minimalEvidence();
      input.linkedArtifacts = [{ source: { run: sourceRun(), artifactPath } }];
      expect(parseRunEvidence(input).status).toBe("malformed");
    }
  });

  it("requires a path or an event id on each source reference", () => {
    const input = minimalEvidence();
    input.linkedArtifacts = [{ source: { run: sourceRun() } }];
    expect(parseRunEvidence(input).status).toBe("malformed");

    const badId = minimalEvidence();
    (badId.linkedArtifacts as unknown[]) = [{ source: { run: sourceRun(), eventId: "../bad" } }];
    expect(parseRunEvidence(badId).status).toBe("malformed");
  });

  it("rejects a bare runId as project identity", () => {
    const input = minimalEvidence();
    (input.run as Record<string, unknown>).project = "trailstep";
    expect(parseRunEvidence(input).status).toBe("malformed");

    const gitRemote = minimalEvidence();
    (gitRemote.run as Record<string, unknown>).project = {
      kind: "git-remote",
      url: "git@github.com:x/y.git",
    };
    expect(parseRunEvidence(gitRemote).status).toBe("malformed");
  });

  it("rejects unsafe run and event ids", () => {
    const input = minimalEvidence();
    (input.run as Record<string, unknown>).runId = "../escape";
    expect(parseRunEvidence(input).status).toBe("malformed");

    const eventId = minimalEvidence();
    (eventId.run as Record<string, unknown>).startedEventId = "a/b";
    expect(parseRunEvidence(eventId).status).toBe("malformed");
  });
});

describe("runEvidenceSchema fixture types", () => {
  it("keeps fixture records assignable to the V1 evidence type", () => {
    const parsed = parseRunEvidence(minimalEvidence());
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") {
      const evidence: RunEvidence = parsed.evidence;
      const source: EvidenceSourceRef = { run: evidence.run, artifactPath: "events.jsonl" };
      expect(source.artifactPath).toBe("events.jsonl");
    }
  });
});
