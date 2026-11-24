import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ArchManifest, RuleId } from "./manifest.js";

/** One reason a manifest cannot be trusted; the self-tests fail on any entry. */
export interface ManifestProblem {
  readonly code: string;
  readonly message: string;
}

const SEVERITIES = new Set(["strict", "report", "review"]);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Validates the manifest against a tree root. Pure over the manifest object plus
 * small filesystem reads: every declared folder and exemption path must resolve,
 * the rule table must be internally closed, and every record must be complete.
 *
 * `root` is injected so a self-test can point at a temp fixture (or a copy with
 * one folder deleted) without touching the real tree — T-4.
 */
export function manifestProblems(manifest: ArchManifest, root: string): readonly ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const add = (code: string, message: string): void => {
    problems.push({ code, message });
  };

  const rankedGroups = manifest.ranks.flatMap((layer) =>
    layer.groups.map((group) => ({ ...group, rank: layer.rank })),
  );
  const allGroups = [...rankedGroups, ...manifest.unrankedGroups];
  const targetGroups = new Set([
    ...manifest.ranks.flatMap((layer) => layer.docGroups),
    ...manifest.unrankedGroups.map((group) => group.targetGroup),
  ]);

  // Ranks: ordered, unique, contiguous, and each folder root resolves with the
  // group's name as its final path segment.
  let previousRank = -1;
  const seenRanks = new Set<number>();
  // A target group belongs to exactly one layer, so a repeat makes G2's order
  // ambiguous. This also catches a duplicate inside one rank's docGroups.
  const seenDocGroups = new Set<string>();
  for (const [index, layer] of manifest.ranks.entries()) {
    if (layer.rank <= previousRank) {
      add(
        "rank-order",
        `rank ${layer.rank} appears after rank ${previousRank}; ranks must be strictly ascending`,
      );
    }
    if (layer.rank !== index) {
      add("rank-order", `rank ${layer.rank} is not the next contiguous rank (expected ${index})`);
    }
    previousRank = layer.rank;
    if (seenRanks.has(layer.rank)) {
      add("rank-duplicate", `rank ${layer.rank} is declared more than once`);
    }
    seenRanks.add(layer.rank);

    if (layer.groups.length === 0) {
      add("rank-groups-empty", `rank ${layer.rank} declares no groups; every rank owns folders`);
    }
    for (const docGroup of layer.docGroups) {
      if (seenDocGroups.has(docGroup)) {
        add(
          "rank-docgroup-duplicate",
          `docGroup "${docGroup}" is declared more than once across ranks`,
        );
      }
      seenDocGroups.add(docGroup);
    }

    // Each group must target a docGroup of its OWN rank: a global membership
    // test would let a group be re-ranked (mcp → execution) without a problem.
    const layerDocGroups = new Set(layer.docGroups);
    for (const group of layer.groups) {
      const folder = join(root, group.root);
      if (!isDirectory(folder)) {
        add(
          "rank-root-missing",
          `rank ${layer.rank} group "${group.name}": folder root "${group.root}" does not exist under ${root}`,
        );
      }
      if (!group.root.endsWith(`/${group.name}`)) {
        add(
          "rank-root-name-mismatch",
          `group "${group.name}" declares root "${group.root}"; the root's final segment must be the group name`,
        );
      }
      if (!layerDocGroups.has(group.targetGroup)) {
        add(
          "rank-target-foreign",
          `group "${group.name}" targets "${group.targetGroup}", which rank ${layer.rank} does not declare (docGroups: ${layer.docGroups.join(", ")})`,
        );
      }
    }
  }

  for (const group of manifest.unrankedGroups) {
    const folder = join(root, group.root);
    if (!isDirectory(folder)) {
      add(
        "rank-root-missing",
        `unranked group "${group.name}": folder root "${group.root}" does not exist under ${root}`,
      );
    }
    if (!group.root.endsWith(`/${group.name}`)) {
      add(
        "rank-root-name-mismatch",
        `unranked group "${group.name}" declares root "${group.root}"; the root's final segment must be the group name`,
      );
    }
    if (!targetGroups.has(group.targetGroup)) {
      add(
        "rank-target-unknown",
        `unranked group "${group.name}" targets "${group.targetGroup}", which no rank's docGroups declares`,
      );
    }
    for (const rank of group.allowedImportRanks) {
      if (!seenRanks.has(rank)) {
        add(
          "rank-target-unknown",
          `unranked group "${group.name}" may import undeclared rank ${rank}`,
        );
      }
    }
  }

  const seenNames = new Set<string>();
  const seenRoots = new Set<string>();
  for (const group of allGroups) {
    if (seenNames.has(group.name)) {
      add("group-duplicate", `group "${group.name}" is declared more than once`);
    }
    seenNames.add(group.name);
    if (seenRoots.has(group.root)) {
      add("group-root-duplicate", `folder root "${group.root}" is declared by more than one group`);
    }
    seenRoots.add(group.root);
  }

  // Declared type-only families are owner folders whose front door is derived
  // (`<folder>.types.ts`), so both the folder and that file must resolve.
  // CONTENT purity (a family really exports only types) needs the compiler API
  // and is owned by the engine/rules stories (104/105), not by this validator.
  const seenFamilies = new Set<string>();
  for (const family of manifest.typeOnlyFamilies) {
    const folder = join(root, family);
    const frontDoor = `${basename(family)}.types.ts`;
    if (!isDirectory(folder)) {
      add(
        "family-folder-missing",
        `declared type-only family "${family}" is not a folder under ${root}`,
      );
    } else if (!isFile(join(folder, frontDoor))) {
      add(
        "family-front-door-missing",
        `declared type-only family "${family}" has no front door "${frontDoor}" under ${root}`,
      );
    }
    if (seenFamilies.has(family)) {
      add("family-duplicate", `declared type-only family "${family}" appears more than once`);
    }
    seenFamilies.add(family);
  }

  // Exemptions are documented exceptions; a path that does not resolve is stale
  // or invented, and either way a lie.
  for (const exemption of manifest.exemptions) {
    if (!pathExists(resolve(root, exemption.path))) {
      add(
        "exemption-path-missing",
        `exemption for ${exemption.rule}: "${exemption.path}" does not exist under ${root}`,
      );
    }
    if (exemption.reason.trim() === "") {
      add(
        "exemption-reason-missing",
        `exemption for ${exemption.rule} at "${exemption.path}" has no reason`,
      );
    }
  }

  // The rule table is closed: ruleOrder and the record keys describe the same
  // set, and every rule carries a usable severity/anchor/fix.
  const seenRuleIds = new Set<RuleId>();
  for (const ruleId of manifest.ruleOrder) {
    if (seenRuleIds.has(ruleId)) {
      add("rule-duplicate", `rule "${ruleId}" appears more than once in ruleOrder`);
    }
    seenRuleIds.add(ruleId);
    if (!Object.hasOwn(manifest.rules, ruleId)) {
      add("rule-missing", `ruleOrder lists "${ruleId}", but the rule table does not define it`);
    }
  }
  for (const ruleId of Object.keys(manifest.rules) as RuleId[]) {
    if (!seenRuleIds.has(ruleId)) {
      add("rule-unlisted", `rule "${ruleId}" is in the rule table but not in ruleOrder`);
    }
    const rule = manifest.rules[ruleId];
    if (!SEVERITIES.has(rule.severity)) {
      add("rule-severity-invalid", `rule "${ruleId}" has unknown severity "${rule.severity}"`);
    }
    if (rule.anchor.trim() === "") {
      add("rule-anchor-missing", `rule "${ruleId}" has no doc anchor`);
    }
    if (rule.fix.trim() === "") {
      add("rule-fix-missing", `rule "${ruleId}" has no fix recipe`);
    } else if (rule.fix.includes("\n")) {
      add(
        "rule-fix-not-one-line",
        `rule "${ruleId}" has a multi-line fix recipe; it must be one line`,
      );
    }
  }

  // Budgets are consumed by G5/G6 and rendered by `arch:explain`.
  if (manifest.budgets.folderWidth.target <= 0) {
    add("budget-invalid", "folderWidth.target must be positive");
  }
  if (manifest.budgets.folderWidth.gate < manifest.budgets.folderWidth.target) {
    add("budget-invalid", "folderWidth.gate must be greater than or equal to folderWidth.target");
  }
  if (manifest.budgets.fileLines.limit <= 0) {
    add("budget-invalid", "fileLines.limit must be positive");
  }
  if (manifest.budgets.fileLines.owner !== "biome") {
    add("budget-invalid", "fileLines is owned by Biome; the checker only reports it");
  }

  // Demotion records must be admissible under the recorded protocol.
  if (manifest.demotionProtocol.minimumNoiseCount < 1) {
    add("demotion-protocol-invalid", "demotionProtocol.minimumNoiseCount must be at least 1");
  }
  if (manifest.demotionProtocol.requiresReviewedCommit !== true) {
    add("demotion-protocol-invalid", "a demotion must require a reviewed commit");
  }
  for (const demotion of manifest.demotions) {
    if (!Object.hasOwn(manifest.rules, demotion.rule) || !seenRuleIds.has(demotion.rule)) {
      add("demotion-unknown-rule", `demotion names unknown rule "${demotion.rule}"`);
    }
    if (demotion.from !== "strict" || demotion.to !== "report") {
      add(
        "demotion-direction-invalid",
        `demotion of "${demotion.rule}" must move strict → report, not ${demotion.from} → ${demotion.to}`,
      );
    }
    if (demotion.noiseCount < manifest.demotionProtocol.minimumNoiseCount) {
      add(
        "demotion-noise-below-threshold",
        `demotion of "${demotion.rule}" cites ${demotion.noiseCount} noise diagnostics; the threshold is ${manifest.demotionProtocol.minimumNoiseCount}`,
      );
    }
    if (demotion.reason.trim() === "") {
      add("demotion-reason-missing", `demotion of "${demotion.rule}" has no reason`);
    }
    if (demotion.reviewedCommit.trim() === "") {
      add("demotion-commit-missing", `demotion of "${demotion.rule}" has no reviewed commit`);
    }
  }

  return problems;
}

/** Throws one loud, itemised error when the manifest is invalid. */
export function assertManifestValid(manifest: ArchManifest, root: string): void {
  const problems = manifestProblems(manifest, root);
  if (problems.length === 0) {
    return;
  }

  const header = `Architecture manifest is invalid (${problems.length} problem${
    problems.length === 1 ? "" : "s"
  }) against ${root}:`;
  throw new Error(
    [header, ...problems.map((problem) => `  - [${problem.code}] ${problem.message}`)].join("\n"),
  );
}
