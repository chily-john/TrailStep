import type { ProviderEvidenceDiagnostic } from "@trailstep/core";

/**
 * Pi persisted-session format (authoritative for pi-coding-agent 1.4.0).
 *
 * Only the v2/v3 tree formats carry stable persisted entry identities. v1 is
 * linear and Pi's loader generates fresh random ids every time it migrates a
 * v1 file, so v1 entries can never be used as activity identity. Future
 * versions are treated as unsupported rather than as an empty measured scan.
 */

export const PI_SESSION_PROVIDER_ID = "pi" as const;
export const PI_SESSION_MIN_SUPPORTED_VERSION = 2 as const;
export const PI_SESSION_MAX_SUPPORTED_VERSION = 3 as const;

export type PiSessionFormatVersion = 2 | 3;

export type PiUsageFacet =
  | "assistant"
  | "tool-result"
  | "standalone"
  | "compaction"
  | "branch-summary";

export interface PiSessionHeader {
  readonly id: string;
  readonly formatVersion: PiSessionFormatVersion;
  readonly cwd?: string;
  readonly parentSession?: string;
}

export interface PiSessionUsageRecord {
  readonly entryId: string;
  readonly facet: PiUsageFacet;
  /** Raw `usage` payload; validated by `pi-usage.ts`. */
  readonly usage: unknown;
  readonly activityKind:
    | "assistant"
    | "tool-result"
    | "standalone-usage"
    | "compaction"
    | "branch-summary";
  readonly model?: string;
  readonly provider?: string;
  readonly responseId?: string;
  readonly usageKind?: string;
}

export type PiSessionHeaderParseResult =
  | { readonly status: "supported"; readonly header: PiSessionHeader }
  | {
      readonly status: "unsupported";
      readonly headerId?: string;
      readonly formatVersion: number;
      readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
    }
  | {
      readonly status: "malformed";
      readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
    };

export type PiSessionRecordParseResult =
  | { readonly status: "usage"; readonly record: PiSessionUsageRecord }
  | { readonly status: "ignored" }
  | {
      readonly status: "malformed";
      readonly diagnostics: readonly ProviderEvidenceDiagnostic[];
    };

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafePiId(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_ID_PATTERN.test(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && !hasControlCharacters(value);
}

function malformed(code: ProviderEvidenceDiagnostic["code"], message: string) {
  return {
    status: "malformed" as const,
    diagnostics: [{ code, message }],
  };
}

/**
 * Parse and classify the session header. `version` absent means v1.
 */
export function parsePiSessionHeader(value: unknown): PiSessionHeaderParseResult {
  if (!isPlainObject(value) || value.type !== "session") {
    return malformed("malformed-record", "Pi session header is missing");
  }

  const rawId = value.id;
  if (!isSafePiId(rawId)) {
    return malformed("malformed-record", "Pi session header id is not a safe identifier");
  }

  const version = value.version === undefined ? 1 : value.version;
  if (typeof version !== "number" || Number.isInteger(version) === false || version < 1) {
    return malformed("malformed-record", "Pi session header version is invalid");
  }

  const cwd = value.cwd;
  if (cwd !== undefined && !isSafeText(cwd, 4096)) {
    return malformed("malformed-record", "Pi session header cwd is invalid");
  }
  const parentSession = value.parentSession;
  if (parentSession !== undefined && !isSafeText(parentSession, 4096)) {
    return malformed("malformed-record", "Pi session header parentSession is invalid");
  }

  if (version < PI_SESSION_MIN_SUPPORTED_VERSION) {
    return {
      status: "unsupported",
      headerId: rawId,
      formatVersion: version,
      diagnostics: [
        {
          code: "unsupported-source",
          message: "Pi v1 linear sessions have no stable persisted entry identity",
        },
      ],
    };
  }
  if (version > PI_SESSION_MAX_SUPPORTED_VERSION) {
    return {
      status: "unsupported",
      headerId: rawId,
      formatVersion: version,
      diagnostics: [
        {
          code: "unsupported-version",
          message: `unsupported Pi session format version ${version}`,
        },
      ],
    };
  }

  return {
    status: "supported",
    header: {
      id: rawId,
      formatVersion: version as PiSessionFormatVersion,
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  };
}

function parseOptionalMessageText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (!isSafeText(value, maxLength) || value.length === 0) return null;
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ISO_DATE_TIME_PATTERN.test(value);
}

/**
 * Validate one persisted entry and identify whether it carries usage.
 *
 * Unknown entry types are ignored (Pi extensions persist arbitrary entries),
 * but a record with the wrong shape for a known usage-bearing type is
 * malformed and is skipped rather than counted partially.
 */
export function parsePiSessionRecord(value: unknown): PiSessionRecordParseResult {
  if (!isPlainObject(value)) {
    return malformed("malformed-record", "Pi session entry is not an object");
  }

  const type = value.type;
  if (typeof type !== "string" || type.length === 0 || type.length > 64) {
    return malformed("malformed-record", "Pi session entry type is invalid");
  }

  const facet = usageFacetFor(type, value);
  if (facet === undefined) {
    return { status: "ignored" };
  }

  const entryId = value.id;
  if (!isSafePiId(entryId)) {
    return malformed("malformed-record", "Pi usage entry id is not a stable safe identifier");
  }
  const parentId = value.parentId;
  if (parentId !== null && !isSafePiId(parentId)) {
    return malformed("malformed-record", "Pi usage entry parentId is invalid");
  }
  if (!isIsoTimestamp(value.timestamp)) {
    return malformed("malformed-record", "Pi usage entry timestamp is invalid");
  }

  if (facet === "assistant" || facet === "tool-result") {
    return parseMessageUsageRecord(value, entryId, facet);
  }
  if (facet === "standalone") {
    return parseStandaloneUsageRecord(value, entryId);
  }
  return parseSummaryUsageRecord(value, entryId, facet);
}

function usageFacetFor(type: string, value: Record<string, unknown>): PiUsageFacet | undefined {
  if (type === "usage") return "standalone";
  if (type === "compaction") return "compaction";
  if (type === "branch_summary") return "branch-summary";
  if (type !== "message") return undefined;

  const message = value.message;
  if (!isPlainObject(message)) {
    return undefined;
  }
  if (message.role === "assistant") return "assistant";
  if (message.role === "toolResult" && message.usage !== undefined) return "tool-result";
  return undefined;
}

function parseMessageUsageRecord(
  value: Record<string, unknown>,
  entryId: string,
  facet: "assistant" | "tool-result",
): PiSessionRecordParseResult {
  const message = value.message;
  if (!isPlainObject(message)) {
    return malformed("malformed-record", "Pi message entry content is invalid");
  }

  const provider = parseOptionalMessageText(message.provider, 256);
  if (provider === null) {
    return malformed("malformed-record", "Pi message provider is invalid");
  }
  const model = parseOptionalMessageText(message.model, 256);
  if (model === null) {
    return malformed("malformed-record", "Pi message model is invalid");
  }
  const responseModel = parseOptionalMessageText(message.responseModel, 256);
  if (responseModel === null) {
    return malformed("malformed-record", "Pi message responseModel is invalid");
  }
  const responseId =
    message.responseId === undefined
      ? undefined
      : isSafePiId(message.responseId)
        ? message.responseId
        : undefined;

  if (message.usage === undefined) {
    if (facet === "assistant") {
      return malformed("malformed-record", "Pi assistant message has no usage payload");
    }
    return { status: "ignored" };
  }

  const resolvedModel = responseModel ?? model;
  return {
    status: "usage",
    record: {
      entryId,
      facet,
      usage: message.usage,
      activityKind: facet,
      ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
      ...(provider === undefined ? {} : { provider }),
      ...(responseId === undefined ? {} : { responseId }),
    },
  };
}

function parseStandaloneUsageRecord(
  value: Record<string, unknown>,
  entryId: string,
): PiSessionRecordParseResult {
  if (!isSafeText(value.kind, 128) || value.kind.length === 0) {
    return malformed("malformed-record", "Pi standalone usage kind is invalid");
  }
  if (value.usage === undefined) {
    return malformed("malformed-record", "Pi standalone usage entry has no usage payload");
  }
  const provider = parseOptionalMessageText(value.provider, 256);
  if (provider === null) {
    return malformed("malformed-record", "Pi standalone usage provider is invalid");
  }
  const model = parseOptionalMessageText(value.model, 256);
  if (model === null) {
    return malformed("malformed-record", "Pi standalone usage model is invalid");
  }

  return {
    status: "usage",
    record: {
      entryId,
      facet: "standalone",
      usage: value.usage,
      activityKind: "standalone-usage",
      usageKind: value.kind,
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
    },
  };
}

function parseSummaryUsageRecord(
  value: Record<string, unknown>,
  entryId: string,
  facet: "compaction" | "branch-summary",
): PiSessionRecordParseResult {
  if (value.usage === undefined) {
    return { status: "ignored" };
  }
  return {
    status: "usage",
    record: {
      entryId,
      facet,
      usage: value.usage,
      activityKind: facet,
    },
  };
}

export function piActivityId(record: PiSessionUsageRecord, sessionId: string): string {
  return `${PI_SESSION_PROVIDER_ID}/${sessionId}/${record.entryId}/${record.facet}`;
}
