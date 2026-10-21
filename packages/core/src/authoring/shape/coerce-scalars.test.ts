import { describe, expect, it } from "vitest";

import { coerceScalarStrings } from "./coerce-scalars.js";

describe("coerceScalarStrings", () => {
  it("coerces top-level number, integer and boolean strings", () => {
    expect(coerceScalarStrings("25", { type: "number" })).toBe(25);
    expect(coerceScalarStrings("-12", { type: "number" })).toBe(-12);
    expect(coerceScalarStrings("3.5", { type: "number" })).toBe(3.5);
    expect(coerceScalarStrings("0", { type: "number" })).toBe(0);
    expect(coerceScalarStrings("-12", { type: "integer" })).toBe(-12);
    expect(coerceScalarStrings("0", { type: "integer" })).toBe(0);
    expect(coerceScalarStrings("true", { type: "boolean" })).toBe(true);
    expect(coerceScalarStrings("false", { type: "boolean" })).toBe(false);
  });

  it("coerces nested object properties", () => {
    const schema = {
      type: "object",
      properties: {
        maxTurns: { type: "number" },
        summarize: { type: "boolean" },
        nested: {
          type: "object",
          properties: {
            turns: { type: "integer" },
            label: { type: "string" },
          },
        },
      },
    };

    expect(
      coerceScalarStrings(
        { maxTurns: "25", summarize: "true", nested: { turns: "3", label: "keep" } },
        schema,
      ),
    ).toEqual({ maxTurns: 25, summarize: true, nested: { turns: 3, label: "keep" } });
  });

  it("coerces array items", () => {
    const schema = {
      type: "object",
      properties: {
        counts: { type: "array", items: { type: "number" } },
        flags: { type: "array", items: { type: "boolean" } },
      },
    };

    expect(coerceScalarStrings({ counts: ["1", "2"], flags: ["true"] }, schema)).toEqual({
      counts: [1, 2],
      flags: [true],
    });
  });

  it("leaves values alone that must never be coerced", () => {
    expect(coerceScalarStrings("abc", { type: "number" })).toBe("abc");
    expect(coerceScalarStrings("25abc", { type: "number" })).toBe("25abc");
    expect(coerceScalarStrings("1e5", { type: "number" })).toBe("1e5");
    expect(coerceScalarStrings("0x10", { type: "number" })).toBe("0x10");
    expect(coerceScalarStrings(" 25 ", { type: "number" })).toBe(" 25 ");
    expect(coerceScalarStrings("", { type: "number" })).toBe("");
    expect(coerceScalarStrings("   ", { type: "number" })).toBe("   ");
    expect(coerceScalarStrings("yes", { type: "boolean" })).toBe("yes");
    expect(coerceScalarStrings("1", { type: "boolean" })).toBe("1");
    expect(coerceScalarStrings("TRUE", { type: "boolean" })).toBe("TRUE");
  });

  it("leaves non-string values alone", () => {
    expect(coerceScalarStrings(25, { type: "number" })).toBe(25);
    expect(coerceScalarStrings(true, { type: "boolean" })).toBe(true);
    expect(coerceScalarStrings(false, { type: "boolean" })).toBe(false);
  });

  it("leaves a schema with no declared type alone", () => {
    const value = { anything: "25" };

    expect(coerceScalarStrings(value, { type: "object", additionalProperties: true })).toEqual({
      anything: "25",
    });
    expect(coerceScalarStrings(value, {})).toEqual({ anything: "25" });
    expect(coerceScalarStrings(value, undefined)).toEqual({ anything: "25" });
  });

  it("does not mutate the input value", () => {
    const input = { maxTurns: "25", nested: { summarize: "true" } };
    const snapshot = JSON.stringify(input);

    const coerced = coerceScalarStrings(input, {
      type: "object",
      properties: {
        maxTurns: { type: "number" },
        nested: { type: "object", properties: { summarize: { type: "boolean" } } },
      },
    });

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.maxTurns).toBe("25");
    expect(coerced).not.toBe(input);
    expect(coerced).toEqual({ maxTurns: 25, nested: { summarize: true } });
  });

  it("returns an equal value when nothing needs coercion", () => {
    const input = { maxTurns: 25, summarize: true };

    expect(
      coerceScalarStrings(input, { type: "object", properties: { maxTurns: { type: "number" } } }),
    ).toEqual(input);
  });

  it("keeps a non-integer decimal string when the schema declares an integer", () => {
    expect(coerceScalarStrings("3.5", { type: "integer" })).toBe("3.5");
  });
});
