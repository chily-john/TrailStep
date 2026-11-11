import { jsonSchema } from "../../authoring/shape/json-schema.js";
import { isPlainObject } from "../../json/guards.js";
import { runEvidenceRunRefSchema, sanitizeRunEvidenceRunRef } from "./evidence.schema.js";
import type {
  ProviderEvidenceAdapterParseResult,
  ProviderEvidenceAdapterV1,
  ProviderEvidenceAttribution,
  ProviderEvidenceDiagnostic,
  ProviderEvidenceLimits,
  ProviderUsageActivity,
  ProviderUsageCost,
  ProviderUsageCounters,
  ProviderUsageEvidenceParseResult,
  ProviderUsageEvidenceRequestParseResult,
  ProviderUsageEvidenceRequestV1,
  ProviderUsageEvidenceV1,
  ProviderUsageSubtotal,
} from "./provider-evidence-adapter.types.js";
import {
  PROVIDER_EVIDENCE_REQUEST_KIND,
  PROVIDER_EVIDENCE_RESPONSE_KIND,
  PROVIDER_EVIDENCE_SCHEMA_VERSION,
} from "./provider-evidence-adapter.types.js";

/**
 * Versioned JSON-schema validation for the A3 provider evidence bridge.
 *
 * Dispatch is kind/version first, exactly like A1 `parseRunEvidence`: unknown
 * versions are explicit `unsupported-version` results, V1 field errors are
 * `malformed`, additive keys are tolerated, and parsed output is rebuilt from
 * an allowlist so adapter fields can never smuggle paths, secrets, functions
 * or parser input downstream.
 */

const ISO_DATE_TIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";
const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const SCOPED_ID_PATTERN =
  "^(?!\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._-]*)*$";
const REVISION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const TEXT_PATTERN = "^[^\\u0000-\\u001F\\u007F]*$";
const CURRENCY_PATTERN = "^[A-Za-z]{3}$";
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const id = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
  pattern: ID_PATTERN,
});
const boundedNumber = { type: "number", minimum: 0, maximum: MAX_SAFE_INTEGER };
const boundedInteger = (minimum: number, maximum: number) => ({
  type: "integer",
  minimum,
  maximum,
});
const observedAtSchema = { type: "string", maxLength: 64, pattern: ISO_DATE_TIME_PATTERN };
const diagnosticSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    code: {
      type: "string",
      enum: [
        "unsupported-version",
        "malformed-record",
        "malformed-request",
        "malformed-response",
        "malformed-export",
        "missing-capability",
        "missing-provider-roots",
        "identity-mismatch",
        "unsupported-source",
        "unreadable-source",
        "permission-denied",
        "budget-exceeded",
        "oversized-response",
        "timeout",
        "aborted",
        "adapter-failed",
        "ambiguous-identity",
        "partial-coverage",
        "changed-source",
      ],
    },
    message: { type: "string", maxLength: 256, pattern: TEXT_PATTERN },
  },
  required: ["code"] as const,
};
const diagnosticsSchema = {
  type: "array",
  maxItems: 16,
  items: diagnosticSchema,
};
const dispatchSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    branchId: id(256),
    stepIndex: boundedInteger(0, 1_000_000),
    stepArtifactId: id(256),
    stepAttempt: boundedInteger(1, 1_000_000),
    executionCwd: { type: "string", minLength: 1, maxLength: 4096, pattern: TEXT_PATTERN },
    promptPhaseIndex: boundedInteger(0, 1_000_000),
    parentStepId: id(256),
    subPromptOrdinal: boundedInteger(0, 1_000_000),
    targetOrdinal: boundedInteger(1, 1_000_000),
    workSpawnTry: boundedInteger(1, 1_000_000),
    formatValidationAttempt: boundedInteger(1, 1_000_000),
    formatSpawnTry: boundedInteger(1, 1_000_000),
    spawnEventId: id(256),
  },
};
const limitsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    maxCandidateRuns: boundedInteger(1, 256),
    maxSessions: boundedInteger(1, 4096),
    maxFiles: boundedInteger(1, 16384),
    maxTotalBytes: boundedInteger(1, 1_073_741_824),
    maxLineBytes: boundedInteger(1, 67_108_864),
    maxEntries: boundedInteger(1, 1_000_000),
    maxActivities: boundedInteger(1, 4096),
    maxResponseBytes: boundedInteger(1, 67_108_864),
    deadlineMs: boundedInteger(1, 600_000),
  },
  required: [
    "maxCandidateRuns",
    "maxSessions",
    "maxFiles",
    "maxTotalBytes",
    "maxLineBytes",
    "maxEntries",
    "maxActivities",
    "maxResponseBytes",
    "deadlineMs",
  ] as const,
};
const countersSchema = {
  type: "object",
  additionalProperties: true,
  minProperties: 1,
  properties: {
    inputTokens: boundedNumber,
    outputTokens: boundedNumber,
    cacheReadTokens: boundedNumber,
    cacheWriteTokens: boundedNumber,
    totalTokens: boundedNumber,
    reasoningTokens: boundedNumber,
    cacheWrite1hTokens: boundedNumber,
  },
};
const costSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    total: boundedNumber,
    input: boundedNumber,
    output: boundedNumber,
    cacheRead: boundedNumber,
    cacheWrite: boundedNumber,
    currency: { type: "string", pattern: CURRENCY_PATTERN },
    basis: { type: "string", const: "reported" },
  },
  required: ["total", "basis"] as const,
};
const attributionSchema = {
  type: "string",
  enum: ["run", "shared", "unattributed", "ambiguous"],
};
const activityKindSchema = {
  type: "string",
  enum: ["assistant", "tool-result", "standalone-usage", "compaction", "branch-summary", "unknown"],
};
const activitySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    activityId: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: SCOPED_ID_PATTERN,
    },
    sessionId: id(256),
    sessionFormatVersion: boundedInteger(1, 1000),
    kind: activityKindSchema,
    model: { type: "string", minLength: 1, maxLength: 256, pattern: TEXT_PATTERN },
    provider: { type: "string", minLength: 1, maxLength: 256, pattern: TEXT_PATTERN },
    responseId: id(256),
    attribution: attributionSchema,
    run: runEvidenceRunRefSchema,
    counters: countersSchema,
    cost: costSchema,
  },
  required: ["activityId", "sessionId", "kind", "attribution", "counters"] as const,
  anyOf: [
    {
      properties: { attribution: { const: "run" } },
      required: ["run"],
    },
    {
      properties: { attribution: { enum: ["shared", "unattributed", "ambiguous"] } },
      not: { required: ["run"] },
    },
  ],
};
const subtotalSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    attribution: attributionSchema,
    run: runEvidenceRunRefSchema,
    model: { type: "string", minLength: 1, maxLength: 256, pattern: TEXT_PATTERN },
    kind: activityKindSchema,
    counters: countersSchema,
    cost: costSchema,
  },
  required: ["attribution", "counters"] as const,
  anyOf: [
    {
      properties: { attribution: { const: "run" } },
      required: ["run"],
    },
    {
      properties: { attribution: { enum: ["shared", "unattributed", "ambiguous"] } },
      not: { required: ["run"] },
    },
  ],
};

export const providerEvidenceLimitsSchema = limitsSchema;

export const providerUsageEvidenceRequestSchema = jsonSchema<ProviderUsageEvidenceRequestV1>({
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: "string", const: PROVIDER_EVIDENCE_REQUEST_KIND },
    schemaVersion: { type: "integer", const: PROVIDER_EVIDENCE_SCHEMA_VERSION },
    observedAt: observedAtSchema,
    provider: {
      type: "object",
      additionalProperties: true,
      properties: {
        registrationId: id(256),
        manifestProviderId: id(256),
      },
      required: ["registrationId", "manifestProviderId"] as const,
    },
    providerRoots: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 1024, pattern: TEXT_PATTERN },
    },
    candidates: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          run: runEvidenceRunRefSchema,
          spawnEventId: id(256),
          sessionId: id(256),
          dispatch: dispatchSchema,
        },
        required: ["run", "spawnEventId"] as const,
      },
    },
    limits: limitsSchema,
  },
  required: [
    "kind",
    "schemaVersion",
    "observedAt",
    "provider",
    "providerRoots",
    "candidates",
    "limits",
  ] as const,
});

export const providerUsageEvidenceSchema = jsonSchema<ProviderUsageEvidenceV1>({
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: "string", const: PROVIDER_EVIDENCE_RESPONSE_KIND },
    schemaVersion: { type: "integer", const: PROVIDER_EVIDENCE_SCHEMA_VERSION },
    adapterRevision: { type: "string", minLength: 1, maxLength: 64, pattern: REVISION_PATTERN },
    observedAt: observedAtSchema,
    status: {
      type: "string",
      enum: ["complete", "partial", "unknown", "unsupported", "unavailable"],
    },
    coverage: { type: "string", enum: ["complete", "partial", "unknown"] },
    activities: { type: "array", maxItems: 4096, items: activitySchema },
    subtotals: { type: "array", maxItems: 1024, items: subtotalSchema },
    diagnostics: diagnosticsSchema,
  },
  required: [
    "kind",
    "schemaVersion",
    "observedAt",
    "status",
    "coverage",
    "activities",
    "subtotals",
    "diagnostics",
  ] as const,
  anyOf: [
    {
      properties: { status: { const: "complete" }, coverage: { const: "complete" } },
      required: ["status", "coverage"],
    },
    {
      properties: {
        status: { const: "partial" },
        coverage: { const: "partial" },
        diagnostics: { type: "array", minItems: 1 },
      },
      required: ["status", "coverage", "diagnostics"],
    },
    {
      properties: {
        status: { const: "unknown" },
        coverage: { const: "unknown" },
        diagnostics: { type: "array", minItems: 1 },
        activities: { type: "array", maxItems: 0 },
        subtotals: { type: "array", maxItems: 0 },
      },
      required: ["status", "coverage", "diagnostics"],
    },
    {
      properties: {
        status: { const: "unsupported" },
        coverage: { const: "unknown" },
        diagnostics: { type: "array", minItems: 1 },
        activities: { type: "array", maxItems: 0 },
        subtotals: { type: "array", maxItems: 0 },
      },
      required: ["status", "coverage", "diagnostics"],
    },
    {
      properties: {
        status: { const: "unavailable" },
        coverage: { const: "unknown" },
        diagnostics: { type: "array", minItems: 1 },
        activities: { type: "array", maxItems: 0 },
        subtotals: { type: "array", maxItems: 0 },
      },
      required: ["status", "coverage", "diagnostics"],
    },
  ],
});

export const DEFAULT_PROVIDER_EVIDENCE_LIMITS: ProviderEvidenceLimits = {
  maxCandidateRuns: 64,
  maxSessions: 256,
  maxFiles: 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  maxEntries: 100_000,
  maxActivities: 4096,
  maxResponseBytes: 4 * 1024 * 1024,
  deadlineMs: 15_000,
};

/**
 * Parse an adapter capability export. Only `schemaVersion` and `readUsage`
 * are behavioral; all other keys are dropped. A missing callable is
 * `malformed`, never a silently absent capability.
 */
export function parseProviderEvidenceAdapter(value: unknown): ProviderEvidenceAdapterParseResult {
  if (isPlainObject(value) === false) {
    return {
      status: "malformed",
      diagnostics: [{ path: "/", message: "must be a plain object" }],
    };
  }

  const record = value as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || Number.isInteger(schemaVersion) === false) {
    return {
      status: "malformed",
      diagnostics: [{ path: "/schemaVersion", message: "must be an integer" }],
    };
  }
  if (schemaVersion !== PROVIDER_EVIDENCE_SCHEMA_VERSION) {
    return {
      status: "unsupported-version",
      schemaVersion,
      diagnostics: [
        {
          code: "unsupported-version",
          message: `unsupported provider evidence adapter version ${schemaVersion}`,
        },
      ],
    };
  }

  const adapterRevision = record.adapterRevision;
  if (
    adapterRevision !== undefined &&
    (typeof adapterRevision !== "string" ||
      adapterRevision.length === 0 ||
      adapterRevision.length > 64 ||
      new RegExp(REVISION_PATTERN).test(adapterRevision) === false)
  ) {
    return {
      status: "malformed",
      diagnostics: [{ path: "/adapterRevision", message: "must be a bounded revision string" }],
    };
  }

  if (typeof record.readUsage !== "function") {
    return {
      status: "malformed",
      diagnostics: [{ path: "/readUsage", message: "must be a function" }],
    };
  }

  return {
    status: "valid",
    adapter: {
      schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
      ...(adapterRevision === undefined ? {} : { adapterRevision: adapterRevision as string }),
      readUsage: record.readUsage as ProviderEvidenceAdapterV1["readUsage"],
    },
  };
}

export function parseProviderUsageEvidenceRequest(
  value: unknown,
): ProviderUsageEvidenceRequestParseResult {
  if (isPlainObject(value) === false) {
    return { status: "malformed", diagnostics: [{ path: "/", message: "must be a plain object" }] };
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const schemaVersion = record.schemaVersion;
  if (typeof kind !== "string" || kind === "") {
    return {
      status: "malformed",
      diagnostics: [{ path: "/kind", message: `must be "${PROVIDER_EVIDENCE_REQUEST_KIND}"` }],
    };
  }
  if (typeof schemaVersion !== "number" || Number.isInteger(schemaVersion) === false) {
    return {
      status: "malformed",
      diagnostics: [{ path: "/schemaVersion", message: "must be an integer" }],
    };
  }
  if (
    kind !== PROVIDER_EVIDENCE_REQUEST_KIND ||
    schemaVersion !== PROVIDER_EVIDENCE_SCHEMA_VERSION
  ) {
    return {
      status: "unsupported-version",
      kind,
      schemaVersion,
      diagnostics: [
        {
          code: "unsupported-version",
          message: `unsupported provider evidence request kind "${kind.slice(0, 64)}" version ${schemaVersion}`,
        },
      ],
    };
  }

  const diagnostics = providerUsageEvidenceRequestSchema.diagnostics(value);
  if (diagnostics.length > 0) {
    return { status: "malformed", diagnostics };
  }

  return { status: "valid", request: sanitizeProviderUsageEvidenceRequest(record) };
}

/**
 * Parse a provider response. Kind/version are checked before any V1 field so
 * a future adapter can never be read as an empty successful scan.
 */
export function parseProviderUsageEvidence(value: unknown): ProviderUsageEvidenceParseResult {
  if (isPlainObject(value) === false) {
    return { status: "malformed", diagnostics: [{ path: "/", message: "must be a plain object" }] };
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const schemaVersion = record.schemaVersion;
  if (typeof kind !== "string" || kind === "") {
    return {
      status: "malformed",
      diagnostics: [{ path: "/kind", message: `must be "${PROVIDER_EVIDENCE_RESPONSE_KIND}"` }],
    };
  }
  if (typeof schemaVersion !== "number" || Number.isInteger(schemaVersion) === false) {
    return {
      status: "malformed",
      diagnostics: [{ path: "/schemaVersion", message: "must be an integer" }],
    };
  }
  if (
    kind !== PROVIDER_EVIDENCE_RESPONSE_KIND ||
    schemaVersion !== PROVIDER_EVIDENCE_SCHEMA_VERSION
  ) {
    return {
      status: "unsupported-version",
      kind,
      schemaVersion,
      diagnostics: [
        {
          code: "unsupported-version",
          message: `unsupported provider usage evidence kind "${kind.slice(0, 64)}" version ${schemaVersion}`,
        },
      ],
    };
  }

  const diagnostics = providerUsageEvidenceSchema.diagnostics(value);
  if (diagnostics.length > 0) {
    return { status: "malformed", diagnostics };
  }

  return { status: "valid", evidence: sanitizeProviderUsageEvidence(record) };
}

export function isProviderUsageEvidence(value: unknown): value is ProviderUsageEvidenceV1 {
  return parseProviderUsageEvidence(value).status === "valid";
}

function sanitizeProviderUsageEvidenceRequest(
  input: Record<string, unknown>,
): ProviderUsageEvidenceRequestV1 {
  const provider = input.provider as Record<string, unknown>;
  const candidates = input.candidates as readonly Record<string, unknown>[];
  return {
    kind: PROVIDER_EVIDENCE_REQUEST_KIND,
    schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
    observedAt: input.observedAt as string,
    provider: {
      registrationId: provider.registrationId as string,
      manifestProviderId: provider.manifestProviderId as string,
    },
    providerRoots: [...(input.providerRoots as readonly string[])],
    candidates: candidates.map((candidate) => ({
      run: sanitizeRunEvidenceRunRef(candidate.run as Record<string, unknown>),
      spawnEventId: candidate.spawnEventId as string,
      ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId as string }),
      ...(candidate.dispatch === undefined
        ? {}
        : { dispatch: sanitizeDispatch(candidate.dispatch as Record<string, unknown>) }),
    })),
    limits: sanitizeLimits(input.limits as Record<string, unknown>),
  };
}

function sanitizeDispatch(input: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "branchId",
    "stepIndex",
    "stepArtifactId",
    "stepAttempt",
    "executionCwd",
    "promptPhaseIndex",
    "parentStepId",
    "subPromptOrdinal",
    "targetOrdinal",
    "workSpawnTry",
    "formatValidationAttempt",
    "formatSpawnTry",
    "spawnEventId",
  ] as const;
  return Object.fromEntries(
    keys.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
  );
}

function sanitizeLimits(input: Record<string, unknown>): ProviderEvidenceLimits {
  return {
    maxCandidateRuns: input.maxCandidateRuns as number,
    maxSessions: input.maxSessions as number,
    maxFiles: input.maxFiles as number,
    maxTotalBytes: input.maxTotalBytes as number,
    maxLineBytes: input.maxLineBytes as number,
    maxEntries: input.maxEntries as number,
    maxActivities: input.maxActivities as number,
    maxResponseBytes: input.maxResponseBytes as number,
    deadlineMs: input.deadlineMs as number,
  };
}

/** Rebuild an allowlisted copy; unknown adapter keys never reach consumers. */
function sanitizeProviderUsageEvidence(input: Record<string, unknown>): ProviderUsageEvidenceV1 {
  return {
    kind: PROVIDER_EVIDENCE_RESPONSE_KIND,
    schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
    ...(input.adapterRevision === undefined
      ? {}
      : { adapterRevision: input.adapterRevision as string }),
    observedAt: input.observedAt as string,
    status: input.status as ProviderUsageEvidenceV1["status"],
    coverage: input.coverage as ProviderUsageEvidenceV1["coverage"],
    activities: (input.activities as readonly Record<string, unknown>[]).map(sanitizeActivity),
    subtotals: (input.subtotals as readonly Record<string, unknown>[]).map(sanitizeSubtotal),
    diagnostics: (input.diagnostics as readonly ProviderEvidenceDiagnostic[]).map((entry) => ({
      code: entry.code,
      ...(entry.message !== undefined ? { message: entry.message } : {}),
    })),
  };
}

function sanitizeActivity(input: Record<string, unknown>): ProviderUsageActivity {
  return {
    activityId: input.activityId as string,
    sessionId: input.sessionId as string,
    ...(input.sessionFormatVersion === undefined
      ? {}
      : { sessionFormatVersion: input.sessionFormatVersion as number }),
    kind: input.kind as ProviderUsageActivity["kind"],
    ...(input.model === undefined ? {} : { model: input.model as string }),
    ...(input.provider === undefined ? {} : { provider: input.provider as string }),
    ...(input.responseId === undefined ? {} : { responseId: input.responseId as string }),
    attribution: input.attribution as ProviderEvidenceAttribution,
    ...(input.run === undefined
      ? {}
      : { run: sanitizeRunEvidenceRunRef(input.run as Record<string, unknown>) }),
    counters: sanitizeCounters(input.counters as Record<string, unknown>),
    ...(input.cost === undefined
      ? {}
      : { cost: sanitizeCost(input.cost as Record<string, unknown>) }),
  };
}

function sanitizeSubtotal(input: Record<string, unknown>): ProviderUsageSubtotal {
  return {
    attribution: input.attribution as ProviderEvidenceAttribution,
    ...(input.run === undefined
      ? {}
      : { run: sanitizeRunEvidenceRunRef(input.run as Record<string, unknown>) }),
    ...(input.model === undefined ? {} : { model: input.model as string }),
    ...(input.kind === undefined ? {} : { kind: input.kind as ProviderUsageSubtotal["kind"] }),
    counters: sanitizeCounters(input.counters as Record<string, unknown>),
    ...(input.cost === undefined
      ? {}
      : { cost: sanitizeCost(input.cost as Record<string, unknown>) }),
  };
}

function sanitizeCounters(input: Record<string, unknown>): ProviderUsageCounters {
  const keys = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "reasoningTokens",
    "cacheWrite1hTokens",
  ] as const;
  return Object.fromEntries(
    keys.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
  ) as ProviderUsageCounters;
}

function sanitizeCost(input: Record<string, unknown>): ProviderUsageCost {
  return {
    total: input.total as number,
    ...(input.input === undefined ? {} : { input: input.input as number }),
    ...(input.output === undefined ? {} : { output: input.output as number }),
    ...(input.cacheRead === undefined ? {} : { cacheRead: input.cacheRead as number }),
    ...(input.cacheWrite === undefined ? {} : { cacheWrite: input.cacheWrite as number }),
    ...(input.currency === undefined ? {} : { currency: input.currency as string }),
    basis: "reported",
  };
}
