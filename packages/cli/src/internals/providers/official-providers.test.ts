import { fileURLToPath, pathToFileURL } from "node:url";

import { parseTrailStepProviderManifest, type TrailStepProviderManifest } from "@trailstep/core";
import { describe, expect, it } from "vitest";

import {
  OFFICIAL_PROVIDER_IDS,
  type OfficialProviderId,
  type OfficialProviderSpec,
  officialProviderSpecFor,
} from "./official-providers.js";

/**
 * The official provider package manifest is the source of truth for what a
 * provider CLI supports: the package ships with the CLI it drives. The CLI's
 * `officialProviderSpecFor()` table is a mirror of that metadata (it is needed
 * before a provider package is installed), so the two must agree.
 *
 * The provider packages are loaded from their workspace sources so this test
 * pins the real manifests instead of a copy.
 */
describe("official provider spec", () => {
  it("agrees with the official provider package manifests", async () => {
    for (const providerId of OFFICIAL_PROVIDER_IDS) {
      const manifest = await loadProviderManifest(providerId);
      const spec = officialProviderSpecFor(providerId);

      expect(manifest.id, `${providerId} manifest id`).toBe(providerId);
      expect(spec, `${providerId} CLI spec`).toBeDefined();
      if (spec === undefined) {
        continue;
      }

      expect(spec.model?.supported, `${providerId} model support`).toBe(manifest.model.supported);
      expect(modelDiscovery(spec), `${providerId} model discovery`).toEqual(
        manifest.model.discovery,
      );

      expect(spec.thinking?.supported, `${providerId} thinking support`).toBe(
        manifest.thinking.supported,
      );
      expect(thinkingLevels(spec), `${providerId} thinking levels`).toEqual(
        manifest.thinking.levels,
      );
    }
  });

  it("does not claim model discovery for providers whose CLI cannot list models", async () => {
    for (const providerId of OFFICIAL_PROVIDER_IDS) {
      const manifest = await loadProviderManifest(providerId);
      const spec = officialProviderSpecFor(providerId);
      const discovery = modelDiscovery(spec);
      if (discovery !== undefined) {
        expect(
          manifest.model.discovery,
          `${providerId} discovery is declared by the manifest`,
        ).toEqual(discovery);
      }
    }
  });
});

function modelDiscovery(spec: OfficialProviderSpec | undefined) {
  if (spec?.model?.supported !== true) {
    return undefined;
  }
  return spec.model.discovery;
}

function thinkingLevels(spec: OfficialProviderSpec | undefined) {
  if (spec?.thinking?.supported !== true) {
    return undefined;
  }
  return spec.thinking.levels;
}

async function loadProviderManifest(
  providerId: OfficialProviderId,
): Promise<TrailStepProviderManifest> {
  const sourceUrl = new URL(`../../../../provider-${providerId}/src/index.ts`, import.meta.url);
  const loaded: unknown = await import(pathToFileURL(fileURLToPath(sourceUrl)).href);
  const provider = readRecord(loaded).trailstepProvider;
  const manifest = readRecord(provider).manifest;
  const diagnostics: string[] = [];
  const parsed = parseTrailStepProviderManifest(
    "trailstepProvider.manifest",
    manifest,
    diagnostics,
  );
  expect(diagnostics, `@trailstep/provider-${providerId} manifest diagnostics`).toEqual([]);
  if (parsed === undefined) {
    throw new Error(`@trailstep/provider-${providerId} manifest could not be parsed.`);
  }
  return parsed;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}
