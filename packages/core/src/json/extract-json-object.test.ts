import { describe, expect, it } from "vitest";

import { extractJsonObject } from "./extract-json-object.js";

describe("extractJsonObject", () => {
  it("parses text that is exactly one JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("ignores trailing prose after the object", () => {
    expect(extractJsonObject('{"a":1} hope that helps!')).toEqual({ a: 1 });
  });

  it("ignores leading prose before the object", () => {
    expect(extractJsonObject('Here you go: {"a":1}')).toEqual({ a: 1 });
  });

  // Regression test for the reported failure: the old "slice from the first
  // `{` to the last `}`" logic produced `{"a":1} :}` and threw.
  it("ignores a stray brace after the object", () => {
    expect(extractJsonObject('{"a":1} :}')).toEqual({ a: 1 });
  });

  it("ignores a stray brace before the object", () => {
    expect(extractJsonObject('use {x} for templates\n{"a":1}')).toEqual({ a: 1 });
  });

  it("extracts an object from a fenced code block", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("returns the whole nested object rather than a truncated prefix", () => {
    expect(extractJsonObject('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
  });

  it("does not end the object at a closing brace inside a string", () => {
    expect(extractJsonObject('{"a":"}"}')).toEqual({ a: "}" });
  });

  it("handles an escaped quote inside a string", () => {
    expect(extractJsonObject('{"a":"say \\"hi\\""}')).toEqual({ a: 'say "hi"' });
  });

  it("returns undefined when there is no object at all", () => {
    expect(extractJsonObject("nothing here")).toBeUndefined();
  });

  it("returns undefined for an unbalanced object instead of throwing", () => {
    expect(extractJsonObject('{"a":1')).toBeUndefined();
  });

  it("returns undefined for a top-level array", () => {
    expect(extractJsonObject("[1,2,3]")).toBeUndefined();
  });

  it("returns the first of two objects", () => {
    expect(extractJsonObject('{"a":1} and {"b":2}')).toEqual({ a: 1 });
  });
});
