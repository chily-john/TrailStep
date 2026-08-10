import { describe, expect, it } from "vitest";
import { findDeprecationsAsOf } from "./deprecation-manifest.js";
import type { DeprecationEntry, DeprecationManifest } from "./deprecations.types.js";

describe("findDeprecationsAsOf", () => {
  it("returns [] for an empty manifest, regardless of query", () => {
    const manifest: DeprecationManifest = [];

    expect(findDeprecationsAsOf(manifest, { package: "@trailstep/core", version: "1.0.0" })).toEqual(
      [],
    );
    expect(
      findDeprecationsAsOf(manifest, { package: "@trailstep/authoring", version: "9.9.9" }),
    ).toEqual([]);
  });

  it("marks an entry with no removedIn as severity warning once deprecatedSince is at/below the query version", () => {
    const entry: DeprecationEntry = {
      package: "@trailstep/core",
      symbol: "step",
      deprecatedSince: "2.0.0",
      message: "step is deprecated.",
    };
    const manifest: DeprecationManifest = [entry];

    const result = findDeprecationsAsOf(manifest, { package: "@trailstep/core", version: "2.0.0" });

    expect(result).toEqual([{ ...entry, severity: "warning" }]);
  });

  it("marks an entry as severity blocking when removedIn is at/below the query version", () => {
    const entry: DeprecationEntry = {
      package: "@trailstep/core",
      symbol: "oldHelper",
      deprecatedSince: "2.0.0",
      removedIn: "3.0.0",
      message: "oldHelper was removed.",
    };
    const manifest: DeprecationManifest = [entry];

    const result = findDeprecationsAsOf(manifest, { package: "@trailstep/core", version: "3.0.0" });

    expect(result).toEqual([{ ...entry, severity: "blocking" }]);
  });

  it("marks an entry as severity warning (not blocking) when removedIn is above the query version", () => {
    const entry: DeprecationEntry = {
      package: "@trailstep/core",
      symbol: "oldHelper",
      deprecatedSince: "2.0.0",
      removedIn: "3.5.0",
      message: "oldHelper will be removed.",
    };
    const manifest: DeprecationManifest = [entry];

    const result = findDeprecationsAsOf(manifest, { package: "@trailstep/core", version: "3.0.0" });

    expect(result).toEqual([{ ...entry, severity: "warning" }]);
  });

  it("only returns entries for the queried package", () => {
    const coreEntry: DeprecationEntry = {
      package: "@trailstep/core",
      symbol: "step",
      deprecatedSince: "1.0.0",
      message: "core deprecation.",
    };
    const authoringEntry: DeprecationEntry = {
      package: "@trailstep/authoring",
      symbol: "defineWorkflow",
      deprecatedSince: "1.0.0",
      message: "authoring deprecation.",
    };
    const manifest: DeprecationManifest = [coreEntry, authoringEntry];

    expect(findDeprecationsAsOf(manifest, { package: "@trailstep/core", version: "1.0.0" })).toEqual([
      { ...coreEntry, severity: "warning" },
    ]);
    expect(
      findDeprecationsAsOf(manifest, { package: "@trailstep/authoring", version: "1.0.0" }),
    ).toEqual([{ ...authoringEntry, severity: "warning" }]);
  });

  it("cumulatively surfaces every deprecation crossed in a multi-major jump in a single call", () => {
    const stepEntry: DeprecationEntry = {
      package: "@trailstep/core",
      symbol: "step",
      deprecatedSince: "2.0.0",
      message: "step is deprecated.",
    };
    const oldHelperEntry: DeprecationEntry = {
      package: "@trailstep/core",
      symbol: "oldHelper",
      deprecatedSince: "2.0.0",
      removedIn: "3.5.0",
      message: "oldHelper was removed.",
    };
    const manifest: DeprecationManifest = [stepEntry, oldHelperEntry];

    const result = findDeprecationsAsOf(manifest, { package: "@trailstep/core", version: "4.0.0" });

    expect(result).toEqual([
      { ...stepEntry, severity: "warning" },
      { ...oldHelperEntry, severity: "blocking" },
    ]);
  });
});
