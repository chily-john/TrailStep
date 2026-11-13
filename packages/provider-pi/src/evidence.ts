import type {
  ProviderEvidenceAdapterV1,
  ProviderEvidenceDiagnostic,
  ProviderUsageEvidenceRequestV1,
  ProviderUsageEvidenceV1,
} from "@trailstep/core";

import { correlatePiSessions } from "./pi-session-correlation.js";
import { discoverPiSessions } from "./pi-session-discovery.js";
import { PI_SESSION_PROVIDER_ID } from "./pi-session-format.js";
import { aggregatePiUsage } from "./pi-usage.js";

export const PI_EVIDENCE_ADAPTER_REVISION = "1" as const;

function diagnostic(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): ProviderEvidenceDiagnostic {
  return { code, message };
}

function dedupeDiagnostics(
  diagnostics: readonly ProviderEvidenceDiagnostic[],
): readonly ProviderEvidenceDiagnostic[] {
  const seen = new Set<string>();
  const result: ProviderEvidenceDiagnostic[] = [];
  for (const entry of diagnostics) {
    const key = `${entry.code}\u0000${entry.message ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length === 16) break;
  }
  return result;
}

function emptyResponse(
  observedAt: string,
  status: "unknown" | "unsupported" | "unavailable",
  diagnostics: readonly ProviderEvidenceDiagnostic[],
): ProviderUsageEvidenceV1 {
  return {
    kind: "trailstep.provider-usage-evidence",
    schemaVersion: 1,
    adapterRevision: PI_EVIDENCE_ADAPTER_REVISION,
    observedAt,
    status,
    coverage: "unknown",
    activities: [],
    subtotals: [],
    diagnostics: dedupeDiagnostics(diagnostics),
  };
}

async function readUsage(
  request: ProviderUsageEvidenceRequestV1,
): Promise<ProviderUsageEvidenceV1> {
  const observedAt = new Date().toISOString();

  if (request.signal?.aborted === true) {
    return emptyResponse(observedAt, "unavailable", [
      diagnostic("aborted", "the provider evidence request was cancelled"),
    ]);
  }
  if (request.kind !== "trailstep.provider-evidence-request" || request.schemaVersion !== 1) {
    return emptyResponse(observedAt, "unsupported", [
      diagnostic("unsupported-version", "unsupported provider evidence request version"),
    ]);
  }
  if (request.provider.manifestProviderId !== PI_SESSION_PROVIDER_ID) {
    return emptyResponse(observedAt, "unsupported", [
      diagnostic("identity-mismatch", "the request provider is not Pi"),
    ]);
  }
  if (
    request.providerRoots.length === 0 ||
    request.providerRoots.every((root) => root.trim() === "")
  ) {
    return emptyResponse(observedAt, "unavailable", [
      diagnostic("missing-provider-roots", "no authorized Pi session roots were provided"),
    ]);
  }
  if (request.candidates.length > request.limits.maxCandidateRuns) {
    return emptyResponse(observedAt, "unavailable", [
      diagnostic("budget-exceeded", "the candidate-run limit was exceeded"),
    ]);
  }

  const discovery = await discoverPiSessions(request.providerRoots, {
    maxFiles: request.limits.maxFiles,
    maxSessions: request.limits.maxSessions,
    maxTotalBytes: request.limits.maxTotalBytes,
    maxLineBytes: request.limits.maxLineBytes,
    maxEntries: request.limits.maxEntries,
    deadlineMs: request.limits.deadlineMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  if (
    discovery.sessions.length === 0 &&
    discovery.diagnostics.some((entry) => entry.code === "missing-provider-roots")
  ) {
    return emptyResponse(observedAt, "unavailable", discovery.diagnostics);
  }

  const correlation = correlatePiSessions(request.candidates, discovery.sessions);
  const aggregation = aggregatePiUsage(discovery.sessions, {
    attributionBySessionId: correlation.bySessionId,
    maxActivities: request.limits.maxActivities,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });

  const diagnostics = dedupeDiagnostics([
    ...discovery.diagnostics,
    ...correlation.diagnostics,
    ...aggregation.diagnostics,
  ]);

  const supportedSessions = discovery.sessions.filter((session) => session.supported);
  const unsupportedSessions = discovery.sessions.filter((session) => !session.supported);
  const hasEvidence = aggregation.activities.length > 0;
  const onlyUnsupportedSources = supportedSessions.length === 0 && unsupportedSessions.length > 0;
  const noSessionsAtAll = discovery.sessions.length === 0;

  if (onlyUnsupportedSources) {
    return emptyResponse(
      observedAt,
      "unsupported",
      diagnostics.length === 0
        ? [diagnostic("unsupported-source", "no supported Pi session format was found")]
        : diagnostics,
    );
  }

  if (noSessionsAtAll) {
    if (discovery.complete && diagnostics.length === 0) {
      return {
        kind: "trailstep.provider-usage-evidence",
        schemaVersion: 1,
        adapterRevision: PI_EVIDENCE_ADAPTER_REVISION,
        observedAt,
        status: "complete",
        coverage: "complete",
        activities: [],
        subtotals: [],
        diagnostics: [],
      };
    }
    if (diagnostics.some((entry) => entry.code === "permission-denied")) {
      return emptyResponse(observedAt, "unavailable", diagnostics);
    }
    return emptyResponse(
      observedAt,
      "unknown",
      diagnostics.length === 0
        ? [diagnostic("unreadable-source", "no candidate Pi session was found")]
        : diagnostics,
    );
  }

  const partial =
    !discovery.complete ||
    !correlation.complete ||
    diagnostics.some((entry) =>
      [
        "malformed-record",
        "budget-exceeded",
        "timeout",
        "aborted",
        "ambiguous-identity",
        "partial-coverage",
        "permission-denied",
        "unreadable-source",
        "unsupported-source",
        "changed-source",
      ].includes(entry.code),
    );

  if (!hasEvidence && !partial) {
    return {
      kind: "trailstep.provider-usage-evidence",
      schemaVersion: 1,
      adapterRevision: PI_EVIDENCE_ADAPTER_REVISION,
      observedAt,
      status: "complete",
      coverage: "complete",
      activities: [],
      subtotals: [],
      diagnostics: [],
    };
  }

  if (!hasEvidence && partial) {
    const partialDiagnostics =
      diagnostics.length === 0
        ? [diagnostic("partial-coverage", "Pi sessions were only partially readable")]
        : diagnostics;
    if (supportedSessions.length > 0) {
      return {
        kind: "trailstep.provider-usage-evidence",
        schemaVersion: 1,
        adapterRevision: PI_EVIDENCE_ADAPTER_REVISION,
        observedAt,
        status: "partial",
        coverage: "partial",
        activities: [],
        subtotals: [],
        diagnostics: dedupeDiagnostics(partialDiagnostics),
      };
    }
    return emptyResponse(observedAt, "unknown", partialDiagnostics);
  }

  const response: ProviderUsageEvidenceV1 = {
    kind: "trailstep.provider-usage-evidence",
    schemaVersion: 1,
    adapterRevision: PI_EVIDENCE_ADAPTER_REVISION,
    observedAt,
    status: partial ? "partial" : "complete",
    coverage: partial ? "partial" : "complete",
    activities: aggregation.activities,
    subtotals: aggregation.subtotals,
    diagnostics: partial
      ? diagnostics.length === 0
        ? [diagnostic("partial-coverage", "Pi usage evidence is incomplete")]
        : diagnostics
      : diagnostics,
  };

  if (Buffer.byteLength(JSON.stringify(response), "utf8") > request.limits.maxResponseBytes) {
    return emptyResponse(observedAt, "unavailable", [
      diagnostic("oversized-response", "the provider evidence response exceeded the byte limit"),
    ]);
  }

  return response;
}

/**
 * Executable Pi evidence capability. It is exported beside the serializable
 * manifest, never inside it, and is entirely off the productive run path.
 */
export const piEvidenceAdapter: ProviderEvidenceAdapterV1 = {
  schemaVersion: 1,
  adapterRevision: PI_EVIDENCE_ADAPTER_REVISION,
  readUsage,
};
