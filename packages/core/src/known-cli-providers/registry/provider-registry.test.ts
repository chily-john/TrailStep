import { describe, expect, it } from "vitest";

import { providerRegistry } from "./provider-registry.js";

describe("providerRegistry", () => {
  it("exposes standardized specs for every built-in provider", () => {
    expect(Object.keys(providerRegistry).sort()).toEqual(["claude", "codex", "gemini", "pi"]);

    for (const [id, provider] of Object.entries(providerRegistry)) {
      expect(provider.spec, `${id} provider spec`).toBeDefined();
      expect(provider.spec?.id).toBe(id);
      expect(provider.spec?.displayName).toEqual(expect.any(String));
      expect(provider.spec?.displayName.length).toBeGreaterThan(0);
    }
  });
});
