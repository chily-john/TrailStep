import { describe, expect, it } from "vitest";

import { parseTrailStepConfigInput } from "./trailstep-config-input.js";

describe("parseTrailStepConfigInput", () => {
  it("parses raw config input into runtime-ready agent mappings", () => {
    const config = parseTrailStepConfigInput({
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
    const parsed = parseTrailStepConfigInput({
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: {
        base: [{ provider: "local", model: "fast" }],
        small: [{ ref: "base" }],
      },
    });

    expect(parseTrailStepConfigInput(parsed)).toBe(parsed);
  });

  it("accepts flattened config with providers and array-based agent mappings", () => {
    const flattened = {
      version: 1,
      customProviders: { local: { binary: "local-agent" } },
      agents: { small: [{ provider: "local", model: "fast" }] },
      settings: { timeout: 30_000 },
      workflows: {
        review: {
          agents: { reviewer: [{ provider: "local", model: "careful" }] },
          settings: { timeout: 10_000 },
        },
      },
    } as const;

    expect(parseTrailStepConfigInput(flattened)).toBe(flattened);
  });
});
