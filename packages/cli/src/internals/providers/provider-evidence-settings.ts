import { resolve } from "node:path";

import { isRecord } from "@trailstep/core";

/**
 * Resolve relative `settings.evidence.providerRoots` against the directory of
 * the config file that declared them.
 *
 * `mergeConfigScopes` deep-merges plain objects and therefore discards which
 * scope a relative path came from. Resolving each scope first preserves the
 * declaring-scope origin: a global relative root stays relative to
 * `~/.trailstep`, a project/local root to `<project>/.trailstep`, even when a
 * higher-precedence scope overrides an unrelated key.
 *
 * Malformed shapes are returned unchanged for `parseTrailStepConfig` to
 * diagnose; this helper never invents structure.
 */
export function resolveProviderEvidenceRootsInScope(
  scopeValue: unknown,
  scopeBaseDir: string,
): unknown {
  if (!isRecord(scopeValue)) {
    return scopeValue;
  }
  const settings = scopeValue.settings;
  if (!isRecord(settings)) {
    return scopeValue;
  }
  const evidence = settings.evidence;
  if (!isRecord(evidence)) {
    return scopeValue;
  }
  const providerRoots = evidence.providerRoots;
  if (!isRecord(providerRoots)) {
    return scopeValue;
  }

  const resolvedRoots = Object.fromEntries(
    Object.entries(providerRoots).map(([providerId, roots]) => [
      providerId,
      Array.isArray(roots)
        ? roots.map((root) => (typeof root === "string" ? resolve(scopeBaseDir, root) : root))
        : roots,
    ]),
  );

  return {
    ...scopeValue,
    settings: {
      ...settings,
      evidence: { ...evidence, providerRoots: resolvedRoots },
    },
  };
}
