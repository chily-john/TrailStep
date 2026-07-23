import { lte } from "semver";

import type {
  DeprecationEntry,
  DeprecationManifest,
  DeprecationStatus,
  DeprecationTargetPackage,
} from "./deprecations.types.js";

// Scaffolding only — genuinely empty. No deprecation exists yet in this codebase. Real entries get
// appended here the day a real breaking change to @stepkit/core or @stepkit/sdk's authoring API
// actually happens. Do not add a fake/example entry to this array.
export const deprecationManifest: DeprecationManifest = [];

export interface FindDeprecationsAsOfQuery {
  readonly package: DeprecationTargetPackage;
  readonly version: string;
}

/**
 * Returns every manifest entry for query.package whose deprecatedSince is at or before
 * query.version, tagged with a severity. Calling this once with version set to a target
 * version naturally captures every entry between the installed version and the target, no matter
 * how many majors are being skipped in one update.
 */
export function findDeprecationsAsOf(
  manifest: DeprecationManifest,
  query: FindDeprecationsAsOfQuery,
): readonly DeprecationStatus[] {
  return manifest
    .filter((entry) => entry.package === query.package && lte(entry.deprecatedSince, query.version))
    .map((entry) => toDeprecationStatus(entry, query.version));
}

function toDeprecationStatus(entry: DeprecationEntry, version: string): DeprecationStatus {
  const isRemoved = entry.removedIn !== undefined && lte(entry.removedIn, version);
  return { ...entry, severity: isRemoved ? "blocking" : "warning" };
}
