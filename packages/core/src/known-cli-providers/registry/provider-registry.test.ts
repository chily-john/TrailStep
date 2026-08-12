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

  it("exposes best-effort model discovery metadata for Pi only", () => {
    expect(providerRegistry.pi.spec.model.supported).toBe(true);
    if (!providerRegistry.pi.spec.model.supported) {
      throw new Error("Pi model overrides should be supported.");
    }
    expect(providerRegistry.pi.spec.model.discovery).toEqual({
      command: "pi",
      args: ["--list-models"],
      outputParser: "pi-list-models-table",
    });

    for (const provider of [
      providerRegistry.claude,
      providerRegistry.codex,
      providerRegistry.gemini,
    ]) {
      expect(
        provider.spec.model.supported ? provider.spec.model.discovery : undefined,
      ).toBeUndefined();
    }
  });
});
