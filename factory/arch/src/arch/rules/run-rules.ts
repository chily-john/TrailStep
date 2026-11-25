import path from "node:path";
import ts from "typescript";
import type { ArchGraph } from "../engine/types.js";
import type { ArchManifest, RuleId } from "../manifest.js";
import { applyExemptions, createDiagnosticComparator } from "./diagnostics.js";
import { g1Cycles } from "./rule-g1.js";
import { g2UpwardImports } from "./rule-g2.js";
import { g4NcaViolations } from "./rule-g4.js";
import { g5FolderWidth } from "./rule-g5.js";
import { g8ReachIns } from "./rule-g8.js";
import { m6AmbientEnv } from "./rule-module.js";
import { n1ReservedFilenames, v4RepeatedPrefixes, v6FrontDoorPresence } from "./rule-naming.js";
import { s5BannedFolderNames, s6InternalImportsSurface, s9MissingLevel } from "./rule-shape.js";
import { t1ColocatedTests, t2CrossCuttingTests } from "./rule-tests.js";
import type { Diagnostic, RuleContext, RuleFunction } from "./types.js";

/** The rev-4 strict set; every entry must have a fixtures entry and a test. */
export type StrictRuleId =
  | "G1"
  | "G2"
  | "G4"
  | "G5"
  | "G8"
  | "S-5"
  | "S-6"
  | "S-9"
  | "V-4"
  | "V-6"
  | "N-1"
  | "M-6"
  | "T-1"
  | "T-2";

/**
 * The strict set's implementations. The coverage test asserts this record and
 * the manifest's strict rules are the same set, so deleting an implementation
 * (or a manifest rule) fails loudly.
 */
export const STRICT_RULE_IMPLEMENTATIONS: Readonly<Record<StrictRuleId, RuleFunction>> = {
  G1: g1Cycles,
  G2: g2UpwardImports,
  G4: g4NcaViolations,
  G5: g5FolderWidth,
  G8: g8ReachIns,
  "S-5": s5BannedFolderNames,
  "S-6": s6InternalImportsSurface,
  "S-9": s9MissingLevel,
  "V-4": v4RepeatedPrefixes,
  "V-6": v6FrontDoorPresence,
  "N-1": n1ReservedFilenames,
  "M-6": m6AmbientEnv,
  "T-1": t1ColocatedTests,
  "T-2": t2CrossCuttingTests,
};

/** G3 is a graph metric and G6 is Biome-owned; neither has a violation list. */
export const METRIC_RULE_IDS = ["G3"] as const;
export const BIOME_OWNED_RULE_IDS = ["G6"] as const;

/** Judgment rules stay review-only until their false-positive rate is measured. */
export const REVIEW_RULE_IDS = ["M-2", "M-7", "S-3"] as const;

export function isStrictRuleId(rule: RuleId): rule is StrictRuleId {
  return Object.hasOwn(STRICT_RULE_IMPLEMENTATIONS, rule);
}

/**
 * The production read seam: rules that need source text receive it through the
 * injected context, never by reading the filesystem themselves (root-injected
 * like `manifestProblems`' `root`). Tests and the fixture harness inject
 * in-memory sources instead.
 */
export function diskRuleContext(graph: ArchGraph): RuleContext {
  return {
    readSource: (filePath: string) => ts.sys.readFile(path.join(graph.projectRoot, filePath)),
  };
}

/** Runs the strict set in manifest order, then applies exemptions and sorting. */
export function runRules(
  graph: ArchGraph,
  manifest: ArchManifest,
  context: RuleContext = diskRuleContext(graph),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const ruleId of manifest.ruleOrder) {
    if (!isStrictRuleId(ruleId)) {
      continue;
    }
    const implementation = STRICT_RULE_IMPLEMENTATIONS[ruleId];
    for (const diagnostic of implementation(graph, manifest, context)) {
      diagnostics.push(diagnostic);
    }
  }

  return applyExemptions(manifest, diagnostics).sort(
    createDiagnosticComparator(manifest.ruleOrder),
  );
}

/** The one-call preview Story 106's `--report` will use. */
export interface ArchCheckResult {
  readonly diagnostics: readonly Diagnostic[];
}

export function runArchCheck(
  graph: ArchGraph,
  manifest: ArchManifest,
  context: RuleContext = diskRuleContext(graph),
): ArchCheckResult {
  return { diagnostics: runRules(graph, manifest, context) };
}
