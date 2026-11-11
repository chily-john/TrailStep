import { describe, expect, it } from "vitest";
import {
  parseProviderEvidenceAdapter,
  parseProviderUsageEvidence,
  parseProviderUsageEvidenceRequest,
} from "./provider-evidence-adapter.schema.js";
import type {
  ProviderUsageEvidenceRequestV1,
  ProviderUsageEvidenceV1,
} from "./provider-evidence-adapter.types.js";

function runRef(): ProviderUsageEvidenceRequestV1["candidates"][number]["run"] {
  return {
    project: { kind: "explicit", key: "trailstep" },
    runId: "run-1",
    startedEventId: "evt-original",
    workflowId: "workflow-a",
    identityQuality: "explicit",
  };
}

function request(
  overrides: Partial<ProviderUsageEvidenceRequestV1> = {},
): ProviderUsageEvidenceRequestV1 {
  return {
    kind: "trailstep.provider-evidence-request",
    schemaVersion: 1,
    observedAt: "2026-11-11T14:00:00.000Z",
    provider: { registrationId: "pi", manifestProviderId: "pi" },
    providerRoots: ["/authorized/pi/sessions"],
    candidates: [
      {
        run: runRef(),
        spawnEventId: "evt-spawn-1",
        sessionId: "session-1",
      },
    ],
    limits: {
      maxCandidateRuns: 8,
      maxSessions: 8,
      maxFiles: 8,
      maxTotalBytes: 1024 * 1024,
      maxLineBytes: 64 * 1024,
      maxEntries: 100,
      maxActivities: 32,
      maxResponseBytes: 64 * 1024,
      deadlineMs: 500,
    },
    ...overrides,
  };
}

function response(overrides: Partial<ProviderUsageEvidenceV1> = {}): Record<string, unknown> {
  return {
    kind: "trailstep.provider-usage-evidence",
    schemaVersion: 1,
    observedAt: "2026-11-11T14:00:01.000Z",
    status: "complete",
    coverage: "complete",
    activities: [
      {
        activityId: "pi/session-1/entry-1/assistant",
        sessionId: "session-1",
        sessionFormatVersion: 3,
        kind: "assistant",
        model: "pi-model",
        provider: "pi",
        responseId: "resp-1",
        attribution: "run",
        run: runRef(),
        counters: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        cost: { total: 0.01, basis: "reported" },
      },
    ],
    subtotals: [
      {
        attribution: "run",
        run: runRef(),
        model: "pi-model",
        kind: "assistant",
        counters: { inputTokens: 10, outputTokens: 5 },
        cost: { total: 0.01, basis: "reported" },
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

describe("provider evidence contract parsing", () => {
  it("parses a V1 request and drops a legacy operation field and unknown keys", () => {
    const input = request() as unknown as Record<string, unknown>;
    input.operation = "readUsage";
    input.futureField = { anything: true };

    const parsed = parseProviderUsageEvidenceRequest(input);
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") {
      expect(parsed.request.kind).toBe("trailstep.provider-evidence-request");
      expect("operation" in parsed.request).toBe(false);
      expect("futureField" in parsed.request).toBe(false);
      expect(parsed.request.providerRoots).toEqual(["/authorized/pi/sessions"]);
    }
  });

  it("distinguishes future request versions from malformed V1 requests", () => {
    const future = { ...request(), schemaVersion: 2 };
    expect(parseProviderUsageEvidenceRequest(future).status).toBe("unsupported-version");

    const missingProvider = request();
    delete (missingProvider as unknown as Record<string, unknown>).provider;
    expect(parseProviderUsageEvidenceRequest(missingProvider).status).toBe("malformed");
  });

  it("requires a callable readUsage and a V1 adapter version", () => {
    expect(parseProviderEvidenceAdapter({ schemaVersion: 1 }).status).toBe("malformed");
    expect(
      parseProviderEvidenceAdapter({ schemaVersion: 2, readUsage: () => undefined }).status,
    ).toBe("unsupported-version");

    const valid = parseProviderEvidenceAdapter({
      schemaVersion: 1,
      adapterRevision: "r1",
      readUsage: async () => response() as unknown as ProviderUsageEvidenceV1,
      extra: "drop",
    });
    expect(valid.status).toBe("valid");
    if (valid.status === "valid") {
      expect(valid.adapter.adapterRevision).toBe("r1");
      expect(typeof valid.adapter.readUsage).toBe("function");
      expect("extra" in valid.adapter).toBe(false);
    }
  });

  it("accepts complete/partial/unknown/unsupported/unavailable responses and rebuilds an allowlist", () => {
    const complete = response();
    complete.futureField = "drop-me";
    complete.providerRoots = ["/private/authorized/root"];
    complete.leakFunction = () => "never serialized";
    const firstActivity = (complete.activities as Record<string, unknown>[])[0];
    if (firstActivity === undefined) throw new Error("fixture activity is missing");
    firstActivity.rawPath = "/private/transcript.jsonl";
    firstActivity.secretCanary = "sk-live-do-not-leak";

    const parsed = parseProviderUsageEvidence(complete);
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") {
      const serialized = JSON.stringify(parsed.evidence);
      expect(serialized).not.toContain("sk-live-do-not-leak");
      expect(serialized).not.toContain("/private/transcript.jsonl");
      expect(serialized).not.toContain("/private/authorized/root");
      expect(serialized).not.toContain("leakFunction");
      expect("futureField" in parsed.evidence).toBe(false);
      expect(parsed.evidence.activities[0]?.counters).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
    }

    const partial = response({
      status: "partial",
      coverage: "partial",
      diagnostics: [{ code: "partial-coverage", message: "scan budget reached" }],
    });
    expect(parseProviderUsageEvidence(partial).status).toBe("valid");

    for (const status of ["unknown", "unsupported", "unavailable"] as const) {
      const result = parseProviderUsageEvidence(
        response({
          status,
          coverage: "unknown",
          activities: [],
          subtotals: [],
          diagnostics: [{ code: "unreadable-source", message: "redacted" }],
        }),
      );
      expect(result.status).toBe("valid");
    }
  });

  it("rejects future versions, malformed V1 responses and invalid counters", () => {
    expect(parseProviderUsageEvidence({ ...response(), schemaVersion: 2 }).status).toBe(
      "unsupported-version",
    );
    expect(parseProviderUsageEvidence({ ...response(), status: "partial" }).status).toBe(
      "malformed",
    );
    expect(
      parseProviderUsageEvidence(
        response({
          status: "unknown",
          coverage: "unknown",
          activities: response().activities as unknown as ProviderUsageEvidenceV1["activities"],
          diagnostics: [{ code: "partial-coverage" }],
        }),
      ).status,
    ).toBe("malformed");

    const negative = response();
    const negativeActivity = (negative.activities as Record<string, unknown>[])[0];
    if (negativeActivity === undefined) throw new Error("fixture activity is missing");
    (negativeActivity.counters as Record<string, unknown>).inputTokens = -1;
    expect(parseProviderUsageEvidence(negative).status).toBe("malformed");

    const noDiagnostics = response({ status: "partial", coverage: "partial", diagnostics: [] });
    expect(parseProviderUsageEvidence(noDiagnostics).status).toBe("malformed");

    const missingRun = response();
    delete ((missingRun.activities as Record<string, unknown>[])[0] as Record<string, unknown>).run;
    expect(parseProviderUsageEvidence(missingRun).status).toBe("malformed");

    const sharedWithRun = response();
    (
      (sharedWithRun.activities as Record<string, unknown>[])[0] as Record<string, unknown>
    ).attribution = "shared";
    expect(parseProviderUsageEvidence(sharedWithRun).status).toBe("malformed");
  });
});
