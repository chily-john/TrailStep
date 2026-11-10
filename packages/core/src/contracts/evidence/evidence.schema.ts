import { jsonSchema } from "../../authoring/shape/json-schema.js";
import { isPlainObject } from "../../json/guards.js";
import type {
  EvidenceAvailability,
  EvidenceDiagnostic,
  EvidenceExecutionObservation,
  EvidenceLinkedArtifactRef,
  EvidenceSourceRef,
  RunEvidence,
  RunEvidenceParseResult,
  RunEvidenceRunRef,
} from "./evidence.types.js";
import { RUN_EVIDENCE_KIND, RUN_EVIDENCE_SCHEMA_VERSION } from "./evidence.types.js";

/**
 * Versioned JSON-schema validation for {@link RunEvidence} V1.
 *
 * Dispatch order is deliberate: `kind`/`schemaVersion` are checked before
 * any V1 field. An unknown major version yields an explicit
 * `unsupported-version` result instead of a successful empty observation or
 * a misleading field error; a V1 record with bad fields yields `malformed`.
 * Additive unknown keys are tolerated for forward compatibility, but parsed
 * output is reconstructed from an allowlist so unknown keys never leak
 * downstream.
 */

const ISO_DATE_TIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";
/** Run/event/workflow IDs: no separators, no traversal, bounded length. */
const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
/** Scoped project keys may contain single `/` segments, never `.`/`..`/empty. */
const SCOPED_KEY_PATTERN =
  "^(?!\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._-]*)*$";
/** Artifact-relative paths: reject traversal, absolute, drive, separators, encoding, and controls. */
const ARTIFACT_PATH_PATTERN =
  "^(?!\\.{1,2}(?:/|$))[A-Za-z0-9._-]+(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9._-]+)*$";
const REVISION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const DIGEST_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
const LABEL_PATTERN = "^[^\\u0000-\\u001F\\u007F]*$";

const id = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
  pattern: ID_PATTERN,
});
const scopedKey = { type: "string", minLength: 1, maxLength: 256, pattern: SCOPED_KEY_PATTERN };
const safeArtifactPath = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: ARTIFACT_PATH_PATTERN,
};
const safeEventId = id(256);
const diagnosticSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    code: {
      type: "string",
      enum: [
        "unsupported-version",
        "malformed-record",
        "missing-source",
        "unreadable-source",
        "changed-source",
        "partial-coverage",
        "ambiguous-identity",
        "budget-exceeded",
        "permission-denied",
        "unsupported-source",
      ],
    },
    message: { type: "string", maxLength: 256, pattern: LABEL_PATTERN },
  },
  required: ["code"] as const,
};
const projectSchema = {
  type: "object",
  additionalProperties: true,
  oneOf: [
    {
      type: "object",
      additionalProperties: true,
      properties: {
        kind: { type: "string", const: "explicit" },
        key: scopedKey,
      },
      required: ["kind", "key"],
    },
    {
      type: "object",
      additionalProperties: true,
      properties: {
        kind: { type: "string", const: "local" },
        rootRef: scopedKey,
      },
      required: ["kind", "rootRef"],
    },
  ],
};
const runRefSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    project: projectSchema,
    runId: id(256),
    startedEventId: safeEventId,
    workflowId: id(256),
    identityQuality: {
      type: "string",
      enum: ["explicit", "local", "legacy-ambiguous", "unknown"],
    },
  },
  required: ["project", "runId", "identityQuality"] as const,
};
const sourceRefSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    run: runRefSchema,
    artifactPath: safeArtifactPath,
    eventId: safeEventId,
    digest: { type: "string", minLength: 1, maxLength: 256, pattern: DIGEST_PATTERN },
  },
  required: ["run"] as const,
  // Exactly one selector: neither (0 matches) and both (2 matches) both fail
  // `oneOf`, instead of `anyOf` which silently allowed both selectors.
  oneOf: [{ required: ["artifactPath"] }, { required: ["eventId"] }],
};
const availabilitySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    state: { type: "string", enum: ["known", "partial", "unknown"] },
    value: { type: "number", minimum: 0 },
    reasons: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      items: {
        type: "string",
        enum: [
          "disabled",
          "missing",
          "unsupported",
          "malformed",
          "ambiguous",
          "permission-denied",
          "budget-exceeded",
        ],
      },
    },
  },
  required: ["state"] as const,
  anyOf: [
    {
      properties: { state: { const: "known" } },
      required: ["value"],
      not: { required: ["reasons"] },
    },
    {
      properties: { state: { const: "partial" } },
      required: ["value", "reasons"],
    },
    {
      properties: { state: { const: "unknown" } },
      required: ["reasons"],
      not: { required: ["value"] },
    },
  ],
};

export const runEvidenceSchema = jsonSchema<RunEvidence>({
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: "string", const: RUN_EVIDENCE_KIND },
    schemaVersion: { type: "integer", const: RUN_EVIDENCE_SCHEMA_VERSION },
    observedAt: { type: "string", maxLength: 64, pattern: ISO_DATE_TIME_PATTERN },
    projectorRevision: { type: "string", minLength: 1, maxLength: 64, pattern: REVISION_PATTERN },
    run: runRefSchema,
    execution: {
      type: "object",
      additionalProperties: true,
      properties: {
        state: {
          type: "string",
          enum: ["active", "waiting", "completed", "failed", "cancelled", "stale", "unknown"],
        },
        storage: { type: "string", enum: ["hot", "archived", "missing", "unreadable"] },
        coverage: { type: "string", enum: ["complete", "partial", "unknown"] },
        diagnostics: {
          type: "array",
          maxItems: 16,
          items: diagnosticSchema,
        },
      },
      required: ["state", "storage", "coverage"] as const,
    },
    usage: availabilitySchema,
    linkedArtifacts: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          label: { type: "string", maxLength: 128, pattern: LABEL_PATTERN },
          source: sourceRefSchema,
        },
        required: ["source"] as const,
      },
    },
  },
  required: [
    "kind",
    "schemaVersion",
    "observedAt",
    "projectorRevision",
    "run",
    "execution",
  ] as const,
});

/**
 * True when `path` is a safe artifact-relative reference: a bounded
 * `/`-separated sequence of plain segments with no traversal (`.`/`..`),
 * absolute/drive prefix, backslash, encoding escape, or control character.
 */
export function isSafeEvidenceArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return false;
  }
  if (new RegExp(ARTIFACT_PATH_PATTERN).test(value) === false) {
    return false;
  }
  // Defence in depth: the Ajv pattern already rejects these, but keep the
  // predicate self-contained for direct callers.
  if (value.includes("\\") || value.includes("%") || value.includes("\0")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return true;
}

export function parseRunEvidence(value: unknown): RunEvidenceParseResult {
  if (isPlainObject(value) === false) {
    return { status: "malformed", diagnostics: [{ path: "/", message: "must be a plain object" }] };
  }

  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const schemaVersion = record.schemaVersion;

  if (typeof kind !== "string" || kind === "") {
    return {
      status: "malformed",
      diagnostics: [{ path: "/kind", message: `must be "${RUN_EVIDENCE_KIND}"` }],
    };
  }
  if (typeof schemaVersion !== "number" || Number.isInteger(schemaVersion) === false) {
    return {
      status: "malformed",
      diagnostics: [{ path: "/schemaVersion", message: "must be an integer" }],
    };
  }

  if (kind !== RUN_EVIDENCE_KIND || schemaVersion !== RUN_EVIDENCE_SCHEMA_VERSION) {
    const diagnostics: readonly EvidenceDiagnostic[] = [
      {
        code: "unsupported-version",
        message: `unsupported evidence kind "${kind.slice(0, 64)}" version ${schemaVersion}`,
      },
    ];
    return { status: "unsupported-version", kind, schemaVersion, diagnostics };
  }

  const diagnostics = runEvidenceSchema.diagnostics(value);
  if (diagnostics.length > 0) {
    return { status: "malformed", diagnostics };
  }

  return { status: "valid", evidence: sanitizeRunEvidence(record) };
}

export function isRunEvidence(value: unknown): value is RunEvidence {
  return parseRunEvidence(value).status === "valid";
}

/** Rebuild an allowlisted copy; unknown additive keys never reach consumers. */
function sanitizeRunEvidence(input: Record<string, unknown>): RunEvidence {
  const base = {
    kind: RUN_EVIDENCE_KIND,
    schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
    observedAt: input.observedAt as string,
    projectorRevision: input.projectorRevision as string,
    run: sanitizeRunRef(input.run as Record<string, unknown>),
    execution: sanitizeExecution(input.execution as Record<string, unknown>),
  };

  const usage = input.usage as EvidenceAvailability<number> | undefined;
  const usageField =
    usage === undefined
      ? {}
      : usage.state === "known"
        ? { usage: { state: "known", value: usage.value } as const }
        : usage.state === "partial"
          ? {
              usage: { state: "partial", value: usage.value, reasons: [...usage.reasons] } as const,
            }
          : { usage: { state: "unknown", reasons: [...usage.reasons] } as const };

  const linked = input.linkedArtifacts as readonly EvidenceLinkedArtifactRef[] | undefined;
  const linkedField =
    linked === undefined
      ? {}
      : {
          linkedArtifacts: linked.map((entry: EvidenceLinkedArtifactRef) =>
            sanitizeLinkedArtifact(entry),
          ),
        };

  return { ...base, ...usageField, ...linkedField };
}

function sanitizeProject(input: Record<string, unknown>): RunEvidenceRunRef["project"] {
  if (input.kind === "explicit") {
    return { kind: "explicit", key: input.key as string };
  }
  return { kind: "local", rootRef: input.rootRef as string };
}

function sanitizeRunRef(input: Record<string, unknown>): RunEvidenceRunRef {
  const ref: RunEvidenceRunRef = {
    project: sanitizeProject(input.project as Record<string, unknown>),
    runId: input.runId as string,
    identityQuality: input.identityQuality as RunEvidenceRunRef["identityQuality"],
  };
  const started = input.startedEventId as string | undefined;
  const workflow = input.workflowId as string | undefined;
  return {
    ...ref,
    ...(started !== undefined ? { startedEventId: started } : {}),
    ...(workflow !== undefined ? { workflowId: workflow } : {}),
  };
}

function sanitizeExecution(input: Record<string, unknown>): EvidenceExecutionObservation {
  const diagnostics = (input.diagnostics as readonly EvidenceDiagnostic[] | undefined) ?? [];
  return {
    state: input.state as EvidenceExecutionObservation["state"],
    storage: input.storage as EvidenceExecutionObservation["storage"],
    coverage: input.coverage as EvidenceExecutionObservation["coverage"],
    diagnostics: diagnostics.map((entry) => ({
      code: entry.code,
      ...(entry.message !== undefined ? { message: entry.message } : {}),
    })),
  };
}

function sanitizeSourceRef(input: EvidenceSourceRef): EvidenceSourceRef {
  const run = sanitizeRunRef(input.run as unknown as Record<string, unknown>);
  const digest = input.digest !== undefined ? { digest: input.digest } : {};
  if (input.artifactPath !== undefined) {
    return { run, artifactPath: input.artifactPath, ...digest };
  }
  if (input.eventId !== undefined) {
    return { run, eventId: input.eventId, ...digest };
  }
  // Unreachable in practice: parseRunEvidence only sanitizes after schema
  // validation, which enforces exactly one selector. Fail loudly rather
  // than silently dropping a selector if this invariant is ever bypassed.
  throw new Error("EvidenceSourceRef requires exactly one of artifactPath/eventId");
}

function sanitizeLinkedArtifact(input: EvidenceLinkedArtifactRef): EvidenceLinkedArtifactRef {
  return {
    source: sanitizeSourceRef(input.source),
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
}
