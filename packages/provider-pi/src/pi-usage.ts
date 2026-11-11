import type {
  ProviderEvidenceDiagnostic,
  ProviderUsageActivity,
  ProviderUsageCost,
  ProviderUsageCounters,
  ProviderUsageSubtotal,
  RunEvidenceRunRef,
} from "@trailstep/core";

import type { PiSessionAttribution } from "./pi-session-correlation.js";
import type { PiDiscoveredSession } from "./pi-session-discovery.js";
import { type PiSessionUsageRecord, piActivityId } from "./pi-session-format.js";

/**
 * Usage extraction, stable-identity deduplication and aggregation.
 *
 * All five authoritative Pi usage sources are extracted exactly once from
 * every valid persisted record (assistant message.usage, standalone usage
 * entries, toolResult message.usage, compaction.usage and branch_summary.usage)
 * including abandoned/off-path tree branches. Identity comes from the session
 * header id + persisted entry id + usage facet, or a stable response id; never
 * from filenames, line numbers, counts, phases, timestamps or counters.
 */

export interface PiUsageDraft {
  readonly sessionId: string;
  readonly formatVersion: number;
  readonly record: PiSessionUsageRecord;
  readonly counters: ProviderUsageCounters;
  readonly cost?: ProviderUsageCost;
  readonly contentKey: string;
}

export interface PiUsageExtractionResult {
  readonly drafts: readonly PiUsageDraft[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
  readonly malformedRecords: number;
  readonly cancelled: boolean;
}

export interface PiUsageAggregationOptions {
  readonly attributionBySessionId: ReadonlyMap<string, PiSessionAttribution>;
  readonly maxActivities: number;
  readonly signal?: AbortSignal;
}

export interface PiUsageAggregationResult {
  readonly activities: readonly ProviderUsageActivity[];
  readonly subtotals: readonly ProviderUsageSubtotal[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
  readonly conflicts: number;
  readonly possibleCopies: number;
  readonly droppedForBudget: number;
}

function diagnostic(
  code: ProviderEvidenceDiagnostic["code"],
  message: string,
): ProviderEvidenceDiagnostic {
  return { code, message };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isFiniteNonNegative(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

interface ParsedUsage {
  readonly counters: ProviderUsageCounters;
  readonly cost?: ProviderUsageCost;
}

function parseCounters(value: unknown): ParsedUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const pairs = [
    ["input", "inputTokens"],
    ["output", "outputTokens"],
    ["cacheRead", "cacheReadTokens"],
    ["cacheWrite", "cacheWriteTokens"],
    ["totalTokens", "totalTokens"],
    ["reasoning", "reasoningTokens"],
    ["cacheWrite1h", "cacheWrite1hTokens"],
  ] as const;

  const counters: Record<string, number> = {};
  let present = 0;
  for (const [sourceKey, targetKey] of pairs) {
    const raw = record[sourceKey];
    if (raw === undefined) continue;
    if (!isFiniteNonNegative(raw)) return undefined;
    counters[targetKey] = raw;
    present += 1;
  }
  if (present === 0) return undefined;

  let cost: ProviderUsageCost | undefined;
  const rawCost = record.cost;
  if (rawCost !== undefined) {
    if (typeof rawCost !== "object" || rawCost === null || Array.isArray(rawCost)) {
      return undefined;
    }
    const costRecord = rawCost as Record<string, unknown>;
    const total = costRecord.total;
    if (total !== undefined && !isFiniteNonNegative(total)) return undefined;
    const components: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const component = costRecord[key];
      if (component === undefined) continue;
      if (!isFiniteNonNegative(component)) return undefined;
      components[key] = component;
    }
    if (total !== undefined) {
      cost = {
        total,
        ...components,
        basis: "reported",
      };
    }
  }

  return {
    counters: counters as ProviderUsageCounters,
    ...(cost === undefined ? {} : { cost }),
  };
}

function contentKeyFor(record: PiSessionUsageRecord, parsed: ParsedUsage): string {
  return JSON.stringify([
    record.activityKind,
    record.provider ?? null,
    record.model ?? null,
    record.responseId ?? null,
    parsed.counters,
    parsed.cost ?? null,
  ]);
}

export function extractPiUsageDrafts(
  sessions: readonly PiDiscoveredSession[],
  signal?: AbortSignal,
): PiUsageExtractionResult {
  const drafts: PiUsageDraft[] = [];
  const diagnostics: ProviderEvidenceDiagnostic[] = [];
  let malformedRecords = 0;
  let cancelled = false;

  for (const session of sessions) {
    if (isAborted(signal)) {
      diagnostics.push(diagnostic("aborted", "usage extraction was cancelled"));
      cancelled = true;
      break;
    }
    if (!session.supported) continue;
    for (const record of session.records) {
      if (isAborted(signal)) {
        diagnostics.push(diagnostic("aborted", "usage extraction was cancelled"));
        cancelled = true;
        break;
      }
      const parsed = parseCounters(record.usage);
      if (parsed === undefined) {
        malformedRecords += 1;
        diagnostics.push(
          diagnostic("malformed-record", "a Pi usage payload could not be normalized"),
        );
        continue;
      }
      drafts.push({
        sessionId: session.sessionId,
        formatVersion: session.formatVersion,
        record,
        counters: parsed.counters,
        ...(parsed.cost === undefined ? {} : { cost: parsed.cost }),
        contentKey: contentKeyFor(record, parsed),
      });
    }
    if (cancelled) break;
  }

  return { drafts, diagnostics: dedupeDiagnostics(diagnostics), malformedRecords, cancelled };
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

function mergeAttributions(attributions: readonly PiSessionAttribution[]): PiSessionAttribution {
  if (attributions.some((value) => value.attribution === "ambiguous")) {
    return { attribution: "ambiguous" };
  }
  if (attributions.some((value) => value.attribution === "shared")) {
    return { attribution: "shared" };
  }
  const runs = new Map<string, RunEvidenceRunRef>();
  for (const value of attributions) {
    if (value.attribution === "run" && value.run !== undefined) {
      runs.set(runKey(value.run), value.run);
    }
  }
  if (runs.size === 1) {
    const run = [...runs.values()][0];
    if (run !== undefined) return { attribution: "run", run };
  }
  if (runs.size > 1) return { attribution: "shared" };
  if (attributions.every((value) => value.attribution === "unattributed")) {
    return { attribution: "unattributed" };
  }
  return { attribution: "ambiguous" };
}

interface DedupedObservation {
  readonly draft: PiUsageDraft;
  readonly attribution: PiSessionAttribution;
}

type MergedDraft =
  | { readonly status: "ok"; readonly draft: PiUsageDraft }
  | { readonly status: "conflict" };

/**
 * Merge repeated observations of one stable identity. Missing optional fields
 * are unknown, not zero; a field observed with different values under the same
 * identity is a conflict and is never resolved by latest/largest-wins.
 */
function mergeDraftGroup(group: readonly PiUsageDraft[]): MergedDraft {
  const first = group[0];
  if (first === undefined) return { status: "conflict" };

  const counterKeys = new Set(group.flatMap((draft) => Object.keys(draft.counters)));
  const counters: Record<string, number> = {};
  for (const key of counterKeys) {
    const values = new Set(
      group.flatMap((draft) => {
        const value = (draft.counters as Record<string, number | undefined>)[key];
        return value === undefined ? [] : [value];
      }),
    );
    if (values.size > 1) return { status: "conflict" };
    const value = [...values][0];
    if (value !== undefined) counters[key] = value;
  }

  const provider = mergeOptionalField(group, "provider");
  const model = mergeOptionalField(group, "model");
  const responseId = mergeOptionalField(group, "responseId");
  if (provider === null || model === null || responseId === null) return { status: "conflict" };

  const activityKinds = new Set(group.map((draft) => draft.record.activityKind));
  const facets = new Set(group.map((draft) => draft.record.facet));
  if (activityKinds.size > 1 || facets.size > 1) return { status: "conflict" };

  let cost: ProviderUsageCost | undefined;
  const withCost = group.filter((draft) => draft.cost !== undefined);
  if (withCost.length > 0) {
    const totals = new Set(withCost.map((draft) => draft.cost?.total));
    if (totals.size > 1) return { status: "conflict" };
    const total = [...totals][0];
    if (total === undefined) return { status: "conflict" };
    const components: Record<string, number> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const values = new Set(
        withCost.flatMap((draft) => {
          const value = draft.cost?.[key];
          return value === undefined ? [] : [value];
        }),
      );
      if (values.size > 1) return { status: "conflict" };
      const value = [...values][0];
      if (value !== undefined) components[key] = value;
    }
    cost = { total, ...components, basis: "reported" };
  }

  const record: PiSessionUsageRecord = {
    ...first.record,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(responseId === undefined ? {} : { responseId }),
  };
  const parsed: ParsedUsage = {
    counters: counters as ProviderUsageCounters,
    ...(cost === undefined ? {} : { cost }),
  };
  return {
    status: "ok",
    draft: {
      ...first,
      record,
      counters: parsed.counters,
      ...(parsed.cost === undefined ? {} : { cost: parsed.cost }),
      contentKey: contentKeyFor(record, parsed),
    },
  };
}

function mergeOptionalField(
  group: readonly PiUsageDraft[],
  field: "provider" | "model" | "responseId",
): string | undefined | null {
  const values = new Set(
    group.flatMap((draft) => {
      const value = draft.record[field];
      return value === undefined ? [] : [value];
    }),
  );
  if (values.size > 1) return null;
  return [...values][0];
}

function attributionFor(
  draft: PiUsageDraft,
  bySessionId: ReadonlyMap<string, PiSessionAttribution>,
): PiSessionAttribution {
  return bySessionId.get(draft.sessionId) ?? { attribution: "ambiguous" };
}

function dedupeDrafts(
  drafts: readonly PiUsageDraft[],
  bySessionId: ReadonlyMap<string, PiSessionAttribution>,
): {
  readonly observations: readonly DedupedObservation[];
  readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
  readonly conflicts: number;
  readonly possibleCopies: number;
} {
  const diagnostics: ProviderEvidenceDiagnostic[] = [];
  let conflicts = 0;
  let possibleCopies = 0;

  const requestGroups = new Map<string, PiUsageDraft[]>();
  const entryGroups = new Map<string, PiUsageDraft[]>();
  for (const draft of drafts) {
    const responseId = draft.record.responseId;
    if (responseId !== undefined) {
      const key = responseId;
      const list = requestGroups.get(key) ?? [];
      list.push(draft);
      requestGroups.set(key, list);
    } else {
      const key = `${draft.sessionId}\u0000${draft.record.entryId}\u0000${draft.record.facet}`;
      const list = entryGroups.get(key) ?? [];
      list.push(draft);
      entryGroups.set(key, list);
    }
  }

  const observations: DedupedObservation[] = [];

  for (const group of requestGroups.values()) {
    const merged = mergeDraftGroup([...group].sort(compareDraft));
    if (merged.status === "conflict") {
      conflicts += 1;
      diagnostics.push(
        diagnostic("ambiguous-identity", "one stable response id reported conflicting usage"),
      );
      continue;
    }
    observations.push({
      draft: merged.draft,
      attribution: mergeAttributions(group.map((draft) => attributionFor(draft, bySessionId))),
    });
  }

  for (const group of entryGroups.values()) {
    const merged = mergeDraftGroup([...group].sort(compareDraft));
    if (merged.status === "conflict") {
      conflicts += 1;
      diagnostics.push(
        diagnostic("ambiguous-identity", "one persisted entry id reported conflicting usage"),
      );
      continue;
    }
    observations.push({
      draft: merged.draft,
      attribution: mergeAttributions(group.map((draft) => attributionFor(draft, bySessionId))),
    });
  }

  // Same persisted entry id under different session headers without a stable
  // response id is a possible fork/clone copy. Keep it visible but never
  // confidently charge it to a run.
  const entryIdGroups = new Map<string, DedupedObservation[]>();
  const finalized: DedupedObservation[] = [];
  for (const observation of observations) {
    if (observation.draft.record.responseId !== undefined) {
      finalized.push(observation);
      continue;
    }
    const key = `${observation.draft.record.entryId}\u0000${observation.draft.record.facet}`;
    const list = entryIdGroups.get(key) ?? [];
    list.push(observation);
    entryIdGroups.set(key, list);
  }

  for (const list of entryIdGroups.values()) {
    const sessionIds = new Set(list.map((entry) => entry.draft.sessionId));
    if (sessionIds.size <= 1) {
      finalized.push(...list);
      continue;
    }
    possibleCopies += 1;
    diagnostics.push(
      diagnostic(
        "ambiguous-identity",
        "the same persisted entry id appears under different sessions without stable request identity",
      ),
    );
    finalized.push(
      ...list.map((entry) => ({ ...entry, attribution: { attribution: "ambiguous" as const } })),
    );
  }

  return {
    observations: finalized,
    diagnostics: dedupeDiagnostics(diagnostics),
    conflicts,
    possibleCopies,
  };
}

function compareDraft(left: PiUsageDraft, right: PiUsageDraft): number {
  const leftKey = `${left.sessionId}\u0000${left.record.entryId}\u0000${left.record.facet}`;
  const rightKey = `${right.sessionId}\u0000${right.record.entryId}\u0000${right.record.facet}`;
  return leftKey.localeCompare(rightKey);
}

function buildActivity(observation: DedupedObservation): ProviderUsageActivity | undefined {
  const { draft, attribution } = observation;
  const activityId = piActivityId(draft.record, draft.sessionId);
  if (activityId.length > 512) return undefined;
  return {
    activityId,
    sessionId: draft.sessionId,
    sessionFormatVersion: draft.formatVersion,
    kind: draft.record.activityKind,
    ...(draft.record.model === undefined ? {} : { model: draft.record.model }),
    ...(draft.record.provider === undefined ? {} : { provider: draft.record.provider }),
    ...(draft.record.responseId === undefined ? {} : { responseId: draft.record.responseId }),
    attribution: attribution.attribution,
    ...(attribution.attribution === "run" && attribution.run !== undefined
      ? { run: attribution.run }
      : {}),
    counters: draft.counters,
    ...(draft.cost === undefined ? {} : { cost: draft.cost }),
  };
}

function counterShape(counters: ProviderUsageCounters): string {
  return Object.keys(counters).sort().join(",");
}

function costShape(cost: ProviderUsageCost | undefined): string {
  return cost === undefined ? "none" : Object.keys(cost).sort().join(",");
}

function sumCounters(activities: readonly ProviderUsageActivity[]): ProviderUsageCounters {
  const keys = Object.keys(activities[0]?.counters ?? {}) as (keyof ProviderUsageCounters)[];
  const totals: Record<string, number> = {};
  for (const key of keys) {
    let total = 0;
    for (const activity of activities) {
      total += activity.counters[key] ?? 0;
    }
    totals[key] = total;
  }
  return totals as ProviderUsageCounters;
}

function sumCosts(activities: readonly ProviderUsageActivity[]): ProviderUsageCost | undefined {
  if (activities.some((activity) => activity.cost === undefined)) return undefined;
  const first = activities[0]?.cost;
  if (first === undefined) return undefined;
  const keys = Object.keys(first) as (keyof ProviderUsageCost)[];
  const result: Record<string, number | string> = { basis: "reported" };
  for (const key of keys) {
    if (key === "basis" || key === "currency") continue;
    let total = 0;
    for (const activity of activities) {
      const value = activity.cost?.[key];
      if (typeof value !== "number") return undefined;
      total += value;
    }
    result[key] = total;
  }
  const currencies = new Set(
    activities.flatMap((activity) =>
      activity.cost?.currency === undefined ? [] : [activity.cost.currency],
    ),
  );
  if (currencies.size === 1) {
    result.currency = [...currencies][0] as string;
  }
  return result as unknown as ProviderUsageCost;
}

function buildSubtotals(activities: readonly ProviderUsageActivity[]): ProviderUsageSubtotal[] {
  const groups = new Map<string, ProviderUsageActivity[]>();
  for (const activity of activities) {
    const run =
      activity.attribution === "run" && activity.run !== undefined ? runKey(activity.run) : "";
    const key = [
      activity.attribution,
      run,
      activity.model ?? "",
      activity.kind ?? "",
      counterShape(activity.counters),
      costShape(activity.cost),
      activity.cost?.currency ?? "",
    ].join("\u0000");
    const list = groups.get(key) ?? [];
    list.push(activity);
    groups.set(key, list);
  }

  const subtotals: ProviderUsageSubtotal[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    if (first === undefined) continue;
    const cost = sumCosts(list);
    subtotals.push({
      attribution: first.attribution,
      ...(first.attribution === "run" && first.run !== undefined ? { run: first.run } : {}),
      ...(first.model === undefined ? {} : { model: first.model }),
      ...(first.kind === undefined ? {} : { kind: first.kind }),
      counters: sumCounters(list),
      ...(cost === undefined ? {} : { cost }),
    });
  }
  return subtotals.sort((left, right) => {
    const leftKey = `${left.attribution}\u0000${left.model ?? ""}\u0000${left.kind ?? ""}`;
    const rightKey = `${right.attribution}\u0000${right.model ?? ""}\u0000${right.kind ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function aggregatePiUsage(
  sessions: readonly PiDiscoveredSession[],
  options: PiUsageAggregationOptions,
): PiUsageAggregationResult {
  const extraction = extractPiUsageDrafts(sessions, options.signal);
  const deduped = dedupeDrafts(extraction.drafts, options.attributionBySessionId);
  const diagnostics = [...extraction.diagnostics, ...deduped.diagnostics];

  const activities: ProviderUsageActivity[] = [];
  let droppedForBudget = 0;
  for (const observation of deduped.observations) {
    const activity = buildActivity(observation);
    if (activity === undefined) {
      diagnostics.push(diagnostic("malformed-record", "a usage activity identity is too long"));
      continue;
    }
    activities.push(activity);
  }
  activities.sort((left, right) => left.activityId.localeCompare(right.activityId));

  const effectiveLimit = Math.min(4096, Math.max(0, options.maxActivities));
  const limited = activities.slice(0, effectiveLimit);
  if (activities.length > limited.length) {
    droppedForBudget = activities.length - limited.length;
    diagnostics.push(
      diagnostic("budget-exceeded", "the activity limit truncated the observed usage set"),
    );
  }

  const allSubtotals = buildSubtotals(limited);
  const subtotals = allSubtotals.slice(0, 1024);
  if (allSubtotals.length > subtotals.length) {
    diagnostics.push(
      diagnostic("budget-exceeded", "the subtotal limit truncated the aggregated usage set"),
    );
  }

  return {
    activities: limited,
    subtotals,
    diagnostics: dedupeDiagnostics(diagnostics),
    conflicts: deduped.conflicts,
    possibleCopies: deduped.possibleCopies,
    droppedForBudget,
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
