import type { PlainObject } from "../../contracts/shapes/shape.types.js";

/**
 * Extraction logic ported from the retired `claude-rpc-trailstep-agent.mjs` mock
 * wrapper's `extractTrailStepOutput`, parameterized by which envelope field holds
 * the provider's final text (e.g. `"result"` for `claude --output-format json`).
 *
 * Handles four shapes of vendor CLI stdout:
 * 1. A single JSON envelope object whose `resultField` holds the final text
 *    (or is itself already the final JSON object).
 * 2. Streaming JSON-lines output, where the last line containing a usable
 *    `resultField`/`content` wins.
 * 3. A `resultField` value that is itself a message-shaped object with a
 *    `content` array of `{type, text}` blocks (confirmed empirically for
 *    `pi --mode json`, whose per-event `"message"` field nests the final
 *    answer inside `message.content[].text` rather than a flat string like
 *    Claude's `"result"`) — all `type: "text"` blocks are concatenated, in
 *    order, and the joined text is parsed the same way a flat string would be.
 * 4. Plain text that itself contains (or is) the JSON object.
 */
export interface EnvelopeOptions {
  readonly resultField: string;
}

export interface EnvelopeMetadataOptions {
  readonly harnessDurationMs: number;
}

export interface ClaudeEnvelopeMetadata {
  readonly usage?: PlainObject;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly harnessDurationMs: number;
  readonly turns?: number;
  readonly sessionId?: string;
}

export function extractEnvelopeMetadata(
  rawStdout: string,
  options: EnvelopeMetadataOptions,
): ClaudeEnvelopeMetadata {
  const metadata: Record<string, unknown> = { harnessDurationMs: options.harnessDurationMs };
  const envelope = parseEnvelopeObject(rawStdout);

  if (envelope) {
    const usage = camelCaseUsage(envelope.usage);
    if (usage) {
      metadata.usage = usage;
    }

    if (typeof envelope.total_cost_usd === "number") {
      metadata.costUsd = envelope.total_cost_usd;
    }

    if (typeof envelope.duration_ms === "number") {
      metadata.durationMs = envelope.duration_ms;
    }

    if (typeof envelope.num_turns === "number") {
      metadata.turns = envelope.num_turns;
    }

    if (typeof envelope.session_id === "string") {
      metadata.sessionId = envelope.session_id;
    }
  }

  return metadata as unknown as ClaudeEnvelopeMetadata;
}

export function extractEnvelopeOutput(rawStdout: string, options: EnvelopeOptions): PlainObject {
  const text = rawStdout.trim();
  if (!text) {
    throw new Error("Provider process returned empty stdout.");
  }

  const parsedEnvelope = parseJson(text);
  if (isPlainObject(parsedEnvelope)) {
    if (parsedEnvelope.is_error === true) {
      throw new Error(
        `Provider reported an error: ${String(parsedEnvelope[options.resultField] ?? text)}`,
      );
    }

    const resolved = resolveFieldValue(parsedEnvelope[options.resultField]);
    if (resolved) {
      return resolved;
    }

    if (typeof parsedEnvelope.content === "string") {
      return parseObjectFromText(parsedEnvelope.content);
    }
  }

  const streamResult = parseLastJsonLineResult(text, options.resultField);
  if (streamResult) {
    return streamResult;
  }

  return parseObjectFromText(text);
}

/**
 * Text-only counterpart to `extractEnvelopeOutput`, for steps whose
 * `captureMode` is `"raw-text"` (see `Document.captureMode` in
 * `authoring/document/document.ts`): the agent's final answer is a plain-text
 * document, not JSON, so the `resultField` value must be taken verbatim
 * rather than JSON-parsed. Mirrors the same four documented stdout shapes as
 * `extractEnvelopeOutput` — single JSON envelope, JSON-lines transcript,
 * message-shaped `resultField` with a `content` block array, and plain text —
 * but never throws on non-JSON text; the raw text is always the answer.
 */
export function extractEnvelopeText(rawStdout: string, options: EnvelopeOptions): string {
  const text = rawStdout.trim();
  if (!text) {
    throw new Error("Provider process returned empty stdout.");
  }

  const parsedEnvelope = parseJson(text);
  if (isPlainObject(parsedEnvelope)) {
    if (parsedEnvelope.is_error === true) {
      throw new Error(
        `Provider reported an error: ${String(parsedEnvelope[options.resultField] ?? text)}`,
      );
    }

    const resolved = resolveFieldText(parsedEnvelope[options.resultField]);
    if (resolved !== undefined) {
      return resolved;
    }

    if (typeof parsedEnvelope.content === "string") {
      return parsedEnvelope.content;
    }
  }

  const streamResult = parseLastJsonLineText(text, options.resultField);
  if (streamResult !== undefined) {
    return streamResult;
  }

  return text;
}

function parseLastJsonLineText(text: string, resultField: string): string | undefined {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of [...lines].reverse()) {
    const parsed = parseJson(line);
    if (!isPlainObject(parsed)) {
      continue;
    }

    const resolved = resolveFieldText(parsed[resultField]);
    if (resolved !== undefined) {
      return resolved;
    }

    if (typeof parsed.content === "string") {
      return parsed.content;
    }
  }

  return undefined;
}

/**
 * Text-only counterpart to `resolveFieldValue`: resolves a raw `resultField`
 * value into the final raw text, handling a plain string (verbatim) or a
 * message-shaped object carrying a `content` array of text blocks (Pi),
 * without ever attempting to JSON-parse the resolved text.
 */
function resolveFieldText(fieldValue: unknown): string | undefined {
  if (typeof fieldValue === "string") {
    return fieldValue;
  }

  if (isPlainObject(fieldValue)) {
    return extractTextFromContentBlocks(fieldValue);
  }

  return undefined;
}

function parseLastJsonLineResult(text: string, resultField: string): PlainObject | undefined {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of [...lines].reverse()) {
    const parsed = parseJson(line);
    if (!isPlainObject(parsed)) {
      continue;
    }

    const resolved = resolveFieldValue(parsed[resultField]);
    if (resolved) {
      return resolved;
    }

    if (typeof parsed.content === "string") {
      return parseObjectFromText(parsed.content);
    }
  }

  return undefined;
}

/**
 * Resolves a raw `resultField` value into the final output object, handling
 * the three shapes that field's value can take across vendors: a JSON-text
 * string (Claude), an object that already is the final output (also legal for
 * Claude-style envelopes), or a message-shaped object carrying a `content`
 * array of text blocks (Pi). Returns `undefined` when `fieldValue` is absent
 * or is a plain object with no extractable text, so callers can fall through
 * to their next fallback instead of misreporting an unrelated object.
 */
function resolveFieldValue(fieldValue: unknown): PlainObject | undefined {
  if (typeof fieldValue === "string") {
    return parseObjectFromText(fieldValue);
  }

  if (isPlainObject(fieldValue)) {
    const blockText = extractTextFromContentBlocks(fieldValue);
    if (blockText !== undefined) {
      return parseObjectFromText(blockText);
    }

    return fieldValue;
  }

  return undefined;
}

/**
 * Extracts and concatenates `text` from every `{type: "text", text: string}`
 * content block in `value.content`, if `value.content` is such an array.
 * Returns `undefined` when `value` has no `content` array to extract from, so
 * the caller can fall back to treating `value` itself as the output object.
 */
function extractTextFromContentBlocks(value: PlainObject): string | undefined {
  const content = value.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .filter(isPlainObject)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("");
}

function parseObjectFromText(text: string): PlainObject {
  const parsed = parseJson(text.trim());
  if (isPlainObject(parsed)) {
    return parsed;
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`Provider response did not contain a JSON object: ${text}`);
  }

  const extracted = parseJson(text.slice(firstBrace, lastBrace + 1));
  if (!isPlainObject(extracted)) {
    throw new Error("Provider response JSON was not an object.");
  }

  return extracted;
}

function parseEnvelopeObject(rawStdout: string): PlainObject | undefined {
  const text = rawStdout.trim();
  const parsed = parseJson(text);
  if (isPlainObject(parsed)) {
    return parsed;
  }

  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of [...lines].reverse()) {
    const parsedLine = parseJson(line);
    if (isPlainObject(parsedLine)) {
      return parsedLine;
    }
  }

  return undefined;
}

function camelCaseUsage(value: unknown): PlainObject | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const usage: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue === "number") {
      usage[snakeToCamel(key)] = fieldValue;
    }
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
