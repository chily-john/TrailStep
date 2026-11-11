import { resolve } from "node:path";

import type {
  ProviderEvidenceCandidateRun,
  ProviderEvidenceDiagnostic,
  RunEvidenceRunRef,
} from "@trailstep/core";

import type { PiDiscoveredSession } from "./pi-session-discovery.js";

/**
 * Candidate-run correlation.
 *
 * A session is charged to a run only when the observed session header id is
 * claimed by exactly one run incarnation. If several runs reference the same
 * session the activity is `shared` and is never included in every run's
 * attributed subtotal. Header cwd is compared with the allowlisted A2
 * execution cwd when both exist; a conflict downgrades attribution to
 * `ambiguous` instead of guessing from time, filename, phase or entry order.
 */

export interface PiSessionAttribution {
  readonly attribution: "run" | "shared" | "unattributed" | "ambiguous";
  readonly run?: RunEvidenceRunRef;
}

export interface PiSessionCorrelationResult {
  readonly bySessionId: ReadonlyMap<string, PiSessionAttribution>;
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
  readonly matchedCandidates: number;
  readonly missingSessions: number;
  readonly complete: boolean;
}

function diagnostic(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): ProviderEvidenceDiagnostic {
  return { code, message };
}

function runKey(run: RunEvidenceRunRef): string {
  const project =
    run.project.kind === "explicit"
      ? `explicit:${run.project.key}`
      : `local:${run.project.rootRef}`;
  return JSON.stringify([
    project,
    run.runId,
    run.startedEventId ?? "",
    run.workflowId ?? "",
    run.identityQuality,
  ]);
}

function normalizedCwd(value: string): string {
  return resolve(value);
}

/** Rebuild only the allowlisted A1 run-reference fields. */
function sanitizeRunRef(run: RunEvidenceRunRef): RunEvidenceRunRef {
  return {
    project:
      run.project.kind === "explicit"
        ? { kind: "explicit", key: run.project.key }
        : { kind: "local", rootRef: run.project.rootRef },
    runId: run.runId,
    ...(run.startedEventId === undefined ? {} : { startedEventId: run.startedEventId }),
    ...(run.workflowId === undefined ? {} : { workflowId: run.workflowId }),
    identityQuality: run.identityQuality,
  };
}

interface CandidateGroup {
  readonly sessionId: string;
  readonly candidates: ProviderEvidenceCandidateRun[];
}

export function correlatePiSessions(
  candidates: readonly ProviderEvidenceCandidateRun[],
  sessions: readonly PiDiscoveredSession[],
): PiSessionCorrelationResult {
  const diagnostics: ProviderEvidenceDiagnostic[] = [];
  const groups = new Map<string, CandidateGroup>();
  let complete = true;
  let missingSessions = 0;
  let matchedCandidates = 0;

  for (const candidate of candidates) {
    const sessionId = candidate.sessionId;
    if (sessionId === undefined) {
      diagnostics.push(
        diagnostic("partial-coverage", "a candidate run has no session identity to correlate"),
      );
      complete = false;
      continue;
    }
    const group = groups.get(sessionId) ?? { sessionId, candidates: [] };
    group.candidates.push(candidate);
    groups.set(sessionId, group);
  }

  const observationsBySessionId = new Map<string, PiDiscoveredSession[]>();
  for (const session of sessions) {
    const list = observationsBySessionId.get(session.sessionId) ?? [];
    list.push(session);
    observationsBySessionId.set(session.sessionId, list);
  }

  const bySessionId = new Map<string, PiSessionAttribution>();

  for (const group of groups.values()) {
    const observations = observationsBySessionId.get(group.sessionId) ?? [];
    if (observations.length === 0) {
      missingSessions += 1;
      diagnostics.push(
        diagnostic(
          "unreadable-source",
          "a candidate session was not found in the authorized roots",
        ),
      );
      complete = false;
      continue;
    }

    matchedCandidates += group.candidates.length;
    const runs = new Map<string, RunEvidenceRunRef>();
    for (const candidate of group.candidates) {
      runs.set(runKey(candidate.run), sanitizeRunRef(candidate.run));
    }

    const sessionCwds = new Set(
      observations.flatMap((observation) =>
        observation.cwd === undefined || observation.cwd === ""
          ? []
          : [normalizedCwd(observation.cwd)],
      ),
    );
    const candidateCwds = new Set(
      group.candidates.flatMap((candidate) => {
        const cwd = candidate.dispatch?.executionCwd;
        return typeof cwd === "string" && cwd.length > 0 ? [normalizedCwd(cwd)] : [];
      }),
    );

    const cwdConflict =
      sessionCwds.size > 1 ||
      (sessionCwds.size > 0 &&
        candidateCwds.size > 0 &&
        [...sessionCwds].every((cwd) => !candidateCwds.has(cwd)));

    if (cwdConflict) {
      diagnostics.push(
        diagnostic(
          "ambiguous-identity",
          "session cwd conflicts with the candidate dispatch execution cwd",
        ),
      );
      complete = false;
      bySessionId.set(group.sessionId, { attribution: "ambiguous" });
      continue;
    }

    if (runs.size === 1) {
      const run = [...runs.values()][0];
      if (run === undefined) {
        bySessionId.set(group.sessionId, { attribution: "ambiguous" });
        complete = false;
        continue;
      }
      bySessionId.set(group.sessionId, { attribution: "run", run });
    } else {
      bySessionId.set(group.sessionId, { attribution: "shared" });
      complete = false;
    }
  }

  for (const session of sessions) {
    if (!bySessionId.has(session.sessionId)) {
      bySessionId.set(session.sessionId, { attribution: "unattributed" });
    }
  }

  return {
    bySessionId,
    diagnostics: dedupeDiagnostics(diagnostics),
    matchedCandidates,
    missingSessions,
    complete,
  };
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
