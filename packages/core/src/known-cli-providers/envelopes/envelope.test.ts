import { describe, expect, it } from "vitest";

import { extractEnvelopeMetadata, extractEnvelopeOutput, extractEnvelopeText } from "./envelope.js";

describe("extractEnvelopeMetadata", () => {
  it("extracts Claude usage metadata from a JSON envelope with camelCased fields", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"greeting":"Hello, Ada!"}',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      },
      total_cost_usd: 0.1234,
      duration_ms: 5678,
      num_turns: 2,
      session_id: "session-123",
    });

    expect(extractEnvelopeMetadata(stdout, { harnessDurationMs: 42 })).toEqual({
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
      },
      costUsd: 0.1234,
      durationMs: 5678,
      harnessDurationMs: 42,
      turns: 2,
      sessionId: "session-123",
    });
  });
});

describe("extractEnvelopeOutput", () => {
  it("parses a single JSON envelope whose result field holds JSON text", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"greeting":"Hello, Ada!"}',
    });

    expect(extractEnvelopeOutput(stdout, { resultField: "result" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("parses an envelope whose result field is already a JSON object", () => {
    const stdout = JSON.stringify({ result: { greeting: "Hello, Ada!" } });

    expect(extractEnvelopeOutput(stdout, { resultField: "result" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("falls back to a content field when the result field is absent", () => {
    const stdout = JSON.stringify({ content: '{"greeting":"Hello, Ada!"}' });

    expect(extractEnvelopeOutput(stdout, { resultField: "result" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("extracts a JSON object embedded in surrounding prose inside the result field", () => {
    const stdout = JSON.stringify({
      result: 'Sure thing! Here you go: {"greeting":"Hello, Ada!"} Hope that helps.',
    });

    expect(extractEnvelopeOutput(stdout, { resultField: "result" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("throws when the envelope reports is_error", () => {
    const stdout = JSON.stringify({ is_error: true, result: "rate limited" });

    expect(() => extractEnvelopeOutput(stdout, { resultField: "result" })).toThrow(
      /reported an error/,
    );
  });

  it("falls back to the last usable JSON line for stream-style stdout", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", content: "thinking..." }),
      JSON.stringify({ type: "result", result: '{"greeting":"Hello, Ada!"}' }),
    ].join("\n");

    expect(extractEnvelopeOutput(stdout, { resultField: "result" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("parses plain-text stdout that is itself the JSON object", () => {
    const stdout = '{"greeting":"Hello, Ada!"}';

    expect(extractEnvelopeOutput(stdout, { resultField: "result" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("extracts a JSON object embedded in plain-text prose with no envelope at all", () => {
    const stdout = 'Here is the answer: {"greeting":"Hello, Ada!"} done.';

    expect(extractEnvelopeOutput(stdout, { resultField: "result" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("throws on empty stdout", () => {
    expect(() => extractEnvelopeOutput("   ", { resultField: "result" })).toThrow(/empty stdout/);
  });

  it("throws when no JSON object can be located anywhere", () => {
    expect(() => extractEnvelopeOutput("no json here", { resultField: "result" })).toThrow(
      /did not contain a JSON object/,
    );
  });

  it("respects a different resultField for a different vendor envelope shape", () => {
    const stdout = JSON.stringify({ output_text: '{"greeting":"Hello, Ada!"}' });

    expect(extractEnvelopeOutput(stdout, { resultField: "output_text" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  // Pi's confirmed field: empirically confirmed by running the real `pi`
  // CLI with `-p "..." --mode json` (see mock-local-test/README.md for the
  // raw probe transcript). Unlike Claude's flat `"result"` string, Pi's
  // `--mode json` prints one JSON object per line for the whole session
  // transcript, and the field carrying the final answer is `"message"` — a
  // message-shaped object (`{role, content: [{type, text}, ...], ...}`)
  // rather than a flat string, so the answer must be pulled out of the
  // content-block array.
  it("extracts Pi's message-shaped resultField from a single content text block", () => {
    const stdout = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: '{"greeting":"Hello, Ada!"}' }],
      },
    });

    expect(extractEnvelopeOutput(stdout, { resultField: "message" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("extracts Pi's message-shaped resultField, skipping a leading thinking block", () => {
    const stdout = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning about it..." },
          { type: "text", text: '{"greeting":"Hello, Ada!"}' },
        ],
      },
    });

    expect(extractEnvelopeOutput(stdout, { resultField: "message" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("finds Pi's message field on the last matching JSON-lines transcript entry, skipping trailing agent_end/agent_settled lines", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"greeting":"stale"}' }],
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"greeting":"Hello, Ada!"}' }],
        },
      }),
      // These trailing lines have no usable "message" field (plural
      // "messages" on agent_end, no message field at all on agent_settled)
      // and must be skipped rather than short-circuiting extraction.
      JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n");

    expect(extractEnvelopeOutput(stdout, { resultField: "message" })).toEqual({
      greeting: "Hello, Ada!",
    });
  });
});

describe("extractEnvelopeText", () => {
  it("returns a plain-text (non-JSON) result field verbatim", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: false,
      result: "# Feature Doc\n\nThis is a markdown document, not JSON.",
    });

    expect(extractEnvelopeText(stdout, { resultField: "result" })).toEqual(
      "# Feature Doc\n\nThis is a markdown document, not JSON.",
    );
  });

  it("returns a JSON-shaped result field's text verbatim without parsing it", () => {
    const stdout = JSON.stringify({ result: '{"greeting":"Hello, Ada!"}' });

    expect(extractEnvelopeText(stdout, { resultField: "result" })).toEqual(
      '{"greeting":"Hello, Ada!"}',
    );
  });

  it("falls back to a content field when the result field is absent", () => {
    const stdout = JSON.stringify({ content: "plain document text" });

    expect(extractEnvelopeText(stdout, { resultField: "result" })).toEqual("plain document text");
  });

  it("throws when the envelope reports is_error", () => {
    const stdout = JSON.stringify({ is_error: true, result: "rate limited" });

    expect(() => extractEnvelopeText(stdout, { resultField: "result" })).toThrow(
      /reported an error/,
    );
  });

  it("falls back to the last usable JSON line for stream-style stdout", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", content: "thinking..." }),
      JSON.stringify({ type: "result", result: "plain markdown document" }),
    ].join("\n");

    expect(extractEnvelopeText(stdout, { resultField: "result" })).toEqual(
      "plain markdown document",
    );
  });

  it("parses plain-text stdout with no envelope at all as the document itself", () => {
    const stdout = "just a plain document, no wrapper at all";

    expect(extractEnvelopeText(stdout, { resultField: "result" })).toEqual(
      "just a plain document, no wrapper at all",
    );
  });

  it("throws on empty stdout", () => {
    expect(() => extractEnvelopeText("   ", { resultField: "result" })).toThrow(/empty stdout/);
  });

  it("extracts Pi's message-shaped resultField from a content text block verbatim", () => {
    const stdout = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "plain markdown document" }],
      },
    });

    expect(extractEnvelopeText(stdout, { resultField: "message" })).toEqual(
      "plain markdown document",
    );
  });

  it("finds Pi's message field on the last matching JSON-lines transcript entry, skipping trailing agent_end/agent_settled lines", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "abc" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "stale" }] },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final markdown document" }],
        },
      }),
      JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n");

    expect(extractEnvelopeText(stdout, { resultField: "message" })).toEqual(
      "final markdown document",
    );
  });
});
