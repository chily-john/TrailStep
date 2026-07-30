import { describe, expect, it } from "vitest";

import { parseStepKitConfigInput } from "./stepkit-config-input.js";

describe("parseStepKitConfigInput", () => {
  it("parses raw config input into runtime-ready agent mappings", () => {
    const config = parseStepKitConfigInput({
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: {
        base: [{ provider: "local", model: "fast" }],
        small: [{ ref: "base" }],
      },
    });

    expect(config).toEqual({
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: {
        base: [{ provider: "local", model: "fast" }],
        small: [{ provider: "local", model: "fast" }],
      },
    });
  });

  it("returns already parsed config without behavioral change", () => {
    const parsed = parseStepKitConfigInput({
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: {
        base: [{ provider: "local", model: "fast" }],
        small: [{ ref: "base" }],
      },
    });

    expect(parseStepKitConfigInput(parsed)).toBe(parsed);
  });

  it("accepts flattened config with providers and array-based agent mappings", () => {
    const flattened = {
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: { small: [{ provider: "local", model: "fast" }] },
      workflows: {
        review: {
          agents: { reviewer: [{ provider: "local", model: "careful" }] },
        },
      },
    } as const;

    expect(parseStepKitConfigInput(flattened)).toBe(flattened);
  });
});
