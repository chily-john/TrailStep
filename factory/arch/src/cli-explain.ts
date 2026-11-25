/**
 * `arch:explain` rendering (Story 106).
 *
 * The CLI embeds no rule prose: the summary is the manifest's anchor + fix
 * recipe (+ optional owner/notes), and legal targets are manifest data
 * (layer order, budgets, conventions, declared families). The good/bad
 * example is derived from the rule's Story 105 fixtures by the entrypoint and
 * passed in here, so this module stays a pure renderer.
 */

import type { ArchManifest, RuleId } from "./arch/manifest.js";
import { type Diagnostic, isStrictRuleId, renderDiagnostic } from "./arch/rules/index.js";

export interface ExplainExample {
  readonly passFiles: readonly string[];
  readonly failFiles: readonly string[];
  readonly diagnostic: Diagnostic | null;
}

export function isKnownRule(manifest: ArchManifest, rule: string): rule is RuleId {
  return Object.hasOwn(manifest.rules, rule);
}

export function knownRuleIds(manifest: ArchManifest): readonly RuleId[] {
  return manifest.ruleOrder;
}

function legalTargets(manifest: ArchManifest, ruleId: RuleId): string[] {
  switch (ruleId) {
    case "G1":
    case "G2": {
      const layers = manifest.ranks.flatMap((rank) => rank.docGroups);
      const ranks = manifest.ranks.map(
        (rank) => `  rank ${rank.rank}: ${rank.docGroups.join(" → ")}`,
      );
      const peers = manifest.ranks.flatMap((rank) =>
        rank.forbiddenPeers.map((pair) => `${pair.from} ↮ ${pair.to}`),
      );
      const shared = [
        `Layer order (first is lowest; imports point toward it): ${layers.join(", ")}`,
        ...ranks,
        `Forbidden same-rank pairs: ${peers.length === 0 ? "none" : peers.join(", ")}`,
      ];
      return ruleId === "G1"
        ? [
            ...shared,
            "Cycle scope: top-level group SCCs plus owner-folder SCCs computed per group",
            "A cross-group cycle is a group SCC only; it is never repeated as an owner-folder cycle",
            "Edge kinds that count: value and type-only; test files are excluded",
          ]
        : shared;
    }
    case "G4": {
      const families = [...manifest.typeOnlyFamilies, ...manifest.contractFamilyRoots];
      return [
        "Scope: the owner's parent is a group root or a folder below one; top-level groups are never G4 cases",
        "Qualifying importer: a non-front-door import into the owner folder from outside it",
        `Value front door: <owner>/<owner>.ts`,
        `Type-only front door: <owner>/<owner>${manifest.conventions.typeOnlySuffix}`,
        `Declared type-only families: ${families.length === 0 ? "none" : families.join(", ")}`,
        "No rank-0 exemption inside a group; an intra-owner import or a front-door import is composition, not a reach-in",
      ];
    }
    case "G5":
      return [
        `Folder width: gate ${manifest.budgets.folderWidth.gate}, target ${manifest.budgets.folderWidth.target}`,
      ];
    case "G6":
      return [
        `File lines: ${manifest.budgets.fileLines.limit} (owner: ${manifest.budgets.fileLines.owner}, ${manifest.budgets.fileLines.biomeRule})`,
      ];
    case "G8":
    case "V-6": {
      const families = [...manifest.typeOnlyFamilies, ...manifest.contractFamilyRoots];
      return [
        `Value front door: <owner>/<owner>.ts`,
        `Type-only front door: <owner>/<owner>${manifest.conventions.typeOnlySuffix}`,
        `Declared type-only families: ${families.length === 0 ? "none" : families.join(", ")}`,
        `Public surface folder (not an owner folder): ${manifest.conventions.publicSurfaceFolder}`,
      ];
    }
    case "S-5":
      return [`Banned folder names: ${manifest.conventions.bannedFolderNames.join(", ")}`];
    case "S-6":
      return [
        `Internal folder: ${manifest.conventions.internalFolder}`,
        `Public surface folder: ${manifest.conventions.publicSurfaceFolder}`,
      ];
    case "V-4":
      return [
        `Repeated-prefix threshold: ${manifest.conventions.repeatedPrefixThreshold} files in one folder`,
      ];
    case "N-1":
      return [
        `Reserved basenames below the package root: ${manifest.conventions.reservedFilenames.join(", ")}`,
      ];
    case "M-6":
      return [`Scope: ${manifest.conventions.internalFolder}/`];
    case "T-1":
    case "T-2":
      return [
        `Test suffix: ${manifest.conventions.testSuffix}`,
        `Cross-cutting test folder: ${manifest.conventions.crossCuttingTestFolder}/`,
      ];
    case "G3":
      return [`Severity: ${manifest.rules[ruleId].severity} (no violation list)`];
    default:
      return ["No rule-specific target list in the manifest; the doc anchor defines it."];
  }
}

function fileLines(files: readonly string[]): string[] {
  const shown = files.slice(0, 8);
  const lines = shown.map((file) => `    - ${file}`);
  if (files.length > shown.length) {
    lines.push(`    … +${files.length - shown.length} more`);
  }
  return lines;
}

export function renderExplain(
  manifest: ArchManifest,
  ruleId: RuleId,
  example: ExplainExample | null,
): string {
  const spec = manifest.rules[ruleId];
  const lines = [
    `${ruleId} — ${spec.anchor}`,
    `Severity: ${spec.severity}`,
    `Doc: ${manifest.docUri}#${spec.anchor}`,
    `Fix: ${spec.fix}`,
  ];
  if (spec.owner !== undefined) {
    lines.push(`Owner: ${spec.owner}`);
  }
  if (spec.notes !== undefined) {
    lines.push(`Notes: ${spec.notes}`);
  }
  lines.push("Legal targets:", ...legalTargets(manifest, ruleId).map((line) => `  ${line}`));
  lines.push("Example:");

  if (!isStrictRuleId(ruleId) || example === null) {
    lines.push(
      "  none — this rule has no checker implementation (report metric, Biome-owned, or review-only).",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(`  Good (fixture tree, no ${ruleId} diagnostic):`, ...fileLines(example.passFiles));
  lines.push(`  Bad (fixture tree, ${ruleId} diagnostic):`);
  if (example.diagnostic === null) {
    lines.push(`    the fail fixture produced no ${ruleId} diagnostic (fixture drift).`);
  } else {
    lines.push(
      ...renderDiagnostic(example.diagnostic)
        .split("\n")
        .map((line) => `    ${line}`),
    );
    lines.push("    Fixture files:", ...fileLines(example.failFiles));
  }
  return `${lines.join("\n")}\n`;
}
