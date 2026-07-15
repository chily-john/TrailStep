import { describe, expect, it } from "vitest";

import { extractEnvelopeOutput } from "./envelope.js";

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
