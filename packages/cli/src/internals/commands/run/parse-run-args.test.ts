import { describe, expect, it } from "vitest";

import { parseRunArgs } from "./parse-run-args.js";

describe("parseRunArgs", () => {
  it("parses --resume without requiring input", () => {
    expect(parseRunArgs(["--resume"])).toEqual({ resume: true });
  });
});
