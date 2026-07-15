import type { PlainObject } from "../../shared/shape.types.js";

/**
 * Extraction logic ported from the retired `claude-rpc-stepkit-agent.mjs` mock
 * wrapper's `extractStepkitOutput`, parameterized by which envelope field holds
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
