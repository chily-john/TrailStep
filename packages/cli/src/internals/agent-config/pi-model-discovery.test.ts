import { describe, expect, it } from "vitest";

import { parsePiModelDiscoveryOutput } from "./pi-model-discovery.js";

describe("parsePiModelDiscoveryOutput", () => {
  it("parses pi --list-models table output", () => {
    const output = ["provider   model", "anthropic  claude-sonnet-4-5", "openai     gpt-5"].join(
      "\n",
    );

    expect(parsePiModelDiscoveryOutput(output)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
  });
});
