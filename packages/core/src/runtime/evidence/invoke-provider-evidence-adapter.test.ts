import { describe, expect, it, vi } from "vitest";

import type {
  ProviderEvidenceRegistryEntry,
  ProviderUsageEvidenceRequestV1,
  ProviderUsageEvidenceV1,
} from "../../contracts/evidence/provider-evidence-adapter.types.js";
import {
  createProviderEvidenceRegistry,
  invokeProviderEvidenceAdapter,
} from "./invoke-provider-evidence-adapter.js";

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

describe("invokeProviderEvidenceAdapter", () => {
  function registryWith(readUsage: (request: ProviderUsageEvidenceRequestV1) => Promise<unknown>): {
    readonly registry: ReturnType<typeof createProviderEvidenceRegistry>;
    readonly readUsage: ReturnType<typeof vi.fn>;
  } {
    const spy = vi.fn(readUsage);
    const entry: ProviderEvidenceRegistryEntry = {
      registrationId: "pi",
      manifestProviderId: "pi",
      adapter: {
        schemaVersion: 1,
        adapterRevision: "fake-1",
        readUsage: spy as unknown as ProviderEvidenceRegistryEntry["adapter"]["readUsage"],
      },
    };
    return { registry: createProviderEvidenceRegistry([entry]), readUsage: spy };
  }

  it("runs a trusted fake adapter end-to-end and passes only the sanitized request", async () => {
    const { registry, readUsage } = registryWith(async (received) => {
      expect(received.providerRoots).toEqual(["/authorized/pi/sessions"]);
      expect(received.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(received)).not.toContain("readUsage");
      return response();
    });

    const result = await invokeProviderEvidenceAdapter({ registry, request: request() });
    expect(result.status).toBe("evidence");
    if (result.status === "evidence") {
      expect(result.evidence.activities).toHaveLength(1);
      expect(result.evidence.activities[0]?.activityId).toBe("pi/session-1/entry-1/assistant");
    }
    expect(readUsage).toHaveBeenCalledOnce();
  });

  it("returns unsupported for an unregistered adapter or identity mismatch without invoking", async () => {
    const { registry, readUsage } = registryWith(async () => response());
    const missing = await invokeProviderEvidenceAdapter({
      registry,
      request: request({ provider: { registrationId: "other", manifestProviderId: "pi" } }),
    });
    expect(missing.status).toBe("unsupported");
    if (missing.status === "unsupported") {
      expect(missing.diagnostics[0]?.code).toBe("missing-capability");
    }

    const mismatch = await invokeProviderEvidenceAdapter({
      registry,
      request: request({ provider: { registrationId: "pi", manifestProviderId: "not-pi" } }),
    });
    expect(mismatch.status).toBe("unsupported");
    if (mismatch.status === "unsupported") {
      expect(mismatch.diagnostics[0]?.code).toBe("identity-mismatch");
    }
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("treats empty authorized roots as unavailable, never as fabricated zero", async () => {
    const { registry, readUsage } = registryWith(async () => response({ activities: [] }));
    const result = await invokeProviderEvidenceAdapter({
      registry,
      request: request({ providerRoots: [] }),
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.diagnostics[0]?.code).toBe("missing-provider-roots");
    }
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("rejects candidate sets above the declared candidate limit", async () => {
    const { registry, readUsage } = registryWith(async () => response());
    const base = request();
    const result = await invokeProviderEvidenceAdapter({
      registry,
      request: request({
        candidates: [
          ...base.candidates,
          ...base.candidates,
          ...base.candidates,
          ...base.candidates,
          ...base.candidates,
          ...base.candidates,
          ...base.candidates,
          ...base.candidates,
          ...base.candidates,
        ],
      }),
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.diagnostics[0]?.code).toBe("budget-exceeded");
    }
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("sanitizes adapter failures instead of leaking thrown messages", async () => {
    const { registry } = registryWith(async () => {
      throw new Error("secret sk-live-do-not-leak at /private/path");
    });
    const result = await invokeProviderEvidenceAdapter({ registry, request: request() });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.diagnostics[0]?.code).toBe("adapter-failed");
      expect(JSON.stringify(result)).not.toContain("sk-live-do-not-leak");
      expect(JSON.stringify(result)).not.toContain("/private/path");
    }
  });

  it("returns timeout and aborted outcomes without hard-preemption claims", async () => {
    const { registry } = registryWith(
      (received) =>
        new Promise((resolve) => {
          received.signal?.addEventListener("abort", () => resolve(response()), { once: true });
        }),
    );

    const timedOut = await invokeProviderEvidenceAdapter({
      registry,
      request: request({
        limits: { ...request().limits, deadlineMs: 10 },
      }),
    });
    expect(timedOut.status).toBe("unavailable");
    if (timedOut.status === "unavailable") {
      expect(timedOut.diagnostics[0]?.code).toBe("timeout");
    }

    const controller = new AbortController();
    controller.abort();
    const aborted = await invokeProviderEvidenceAdapter({
      registry,
      request: request({ signal: controller.signal }),
    });
    expect(aborted.status).toBe("unavailable");
    if (aborted.status === "unavailable") {
      expect(aborted.diagnostics[0]?.code).toBe("aborted");
    }
  });

  it("rejects oversized and malformed responses, and future response versions", async () => {
    const oversized = await invokeProviderEvidenceAdapter({
      registry: registryWith(async () => response()).registry,
      request: request({ limits: { ...request().limits, maxResponseBytes: 32 } }),
    });
    expect(oversized.status).toBe("unavailable");
    if (oversized.status === "unavailable") {
      expect(oversized.diagnostics[0]?.code).toBe("oversized-response");
    }

    const malformed = await invokeProviderEvidenceAdapter({
      registry: registryWith(async () => ({ kind: "trailstep.provider-usage-evidence" })).registry,
      request: request(),
    });
    expect(malformed.status).toBe("unavailable");
    if (malformed.status === "unavailable") {
      expect(malformed.diagnostics[0]?.code).toBe("malformed-response");
    }

    const future = await invokeProviderEvidenceAdapter({
      registry: registryWith(async () => ({ ...response(), schemaVersion: 2 })).registry,
      request: request(),
    });
    expect(future.status).toBe("unsupported");
    if (future.status === "unsupported") {
      expect(future.diagnostics[0]?.code).toBe("unsupported-version");
    }
  });

  it("rejects duplicate registry registrations", () => {
    const entry: ProviderEvidenceRegistryEntry = {
      registrationId: "pi",
      manifestProviderId: "pi",
      adapter: {
        schemaVersion: 1,
        readUsage: async () => response() as unknown as ProviderUsageEvidenceV1,
      },
    };
    expect(() => createProviderEvidenceRegistry([entry, entry])).toThrow(/Duplicate/);
  });
});
