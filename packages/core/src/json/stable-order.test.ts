import { describe, expect, it } from "vitest";
import path from "node:path";
import { serializeOrdered } from "./ordered-serialize.js";
import { load } from "../load-order.js";

describe("stable order and load order (red)", () => {
  it("serializes with explicit key array, not insertion order", () => {
    expect(serializeOrdered({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("loader continues through broken file with stderr warning, does not throw", () => {
    const dir = path.resolve(import.meta.dirname, "../../../../.trailstep/mcp/");
    expect(() => load({ dir })).not.toThrow();
  });
});
