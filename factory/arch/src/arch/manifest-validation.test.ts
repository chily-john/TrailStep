import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "../repo/root.js";
import { type ArchManifest, manifest, type RuleId, type RuleSpec } from "./manifest.js";
import { assertManifestValid, manifestProblems } from "./manifest-validation.js";

const REPO_ROOT = findRepoRoot();
const tempRoots: string[] = [];

/**
 * Materialises only the folders the manifest declares, under a fresh temp root.
 * The validator is root-injected (T-4), so this is the seam the red phase uses:
 * delete one folder and the self-test must fail loudly without touching the repo.
 */
function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "trailstep-arch-manifest-"));
  tempRoots.push(root);

  for (const layer of manifest.ranks) {
    for (const group of layer.groups) {
      mkdirSync(join(root, group.root), { recursive: true });
    }
  }
  for (const group of manifest.unrankedGroups) {
    mkdirSync(join(root, group.root), { recursive: true });
  }
  for (const family of manifest.typeOnlyFamilies) {
    mkdirSync(join(root, family), { recursive: true });
    writeFileSync(join(root, family, `${basename(family)}.types.ts`), "");
  }
  // Pending contract families are folders only: their `.types.ts` door is the
  // W6 target, so the temp tree deliberately does not create it.
  for (const family of manifest.contractFamilyRoots) {
    mkdirSync(join(root, family), { recursive: true });
  }

  return root;
}

function problemCodes(problems: readonly { code: string }[]): string[] {
  return problems.map((problem) => problem.code);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("manifest validation", () => {
  it("accepts the real manifest against the real tree", () => {
    expect(manifestProblems(manifest, REPO_ROOT)).toEqual([]);
  });

  it("accepts a temp tree that mirrors the declared folders", () => {
    expect(manifestProblems(manifest, tempTree())).toEqual([]);
  });

  it("fails loudly when a rank folder is deleted from a temp copy", () => {
    const root = tempTree();
    const deleted = join(root, "packages/core/src/runs");
    rmSync(deleted, { recursive: true });

    const problems = manifestProblems(manifest, root);

    expect(problemCodes(problems)).toContain("rank-root-missing");
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      'folder root "packages/core/src/runs" does not exist',
    );
    expect(() => assertManifestValid(manifest, root)).toThrowError(
      /Architecture manifest is invalid[\s\S]*rank-root-missing[\s\S]*packages\/core\/src\/runs/,
    );
  });

  it("fails loudly when a declared type-only family folder is deleted", () => {
    const root = tempTree();
    rmSync(join(root, "packages/core/src/contracts/run-context"), { recursive: true });

    expect(problemCodes(manifestProblems(manifest, root))).toContain("family-folder-missing");
  });

  it("fails loudly when a declared type-only family has no front-door file", () => {
    const root = tempTree();
    rmSync(join(root, "packages/core/src/contracts/run-context/run-context.types.ts"));

    const problems = manifestProblems(manifest, root);

    expect(problemCodes(problems)).toContain("family-front-door-missing");
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      'declared type-only family "packages/core/src/contracts/run-context" has no front door "run-context.types.ts"',
    );
  });

  it("fails loudly when a family is declared whose front door does not exist", () => {
    // The reviewer's P3 probe: `contracts/agents` exists, but its W6 front door
    // `agents.types.ts` does not; declaring it type-only must fail.
    const broken: ArchManifest = {
      ...manifest,
      typeOnlyFamilies: [...manifest.typeOnlyFamilies, "packages/core/src/contracts/agents"],
    };

    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain(
      "family-front-door-missing",
    );
  });

  it("fails loudly for a pending contract family whose folder does not exist", () => {
    const broken: ArchManifest = {
      ...manifest,
      contractFamilyRoots: ["packages/core/src/contracts/does-not-exist"],
    };

    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain(
      "contract-family-folder-missing",
    );
  });

  it("fails loudly when a folder is both materialized and pending", () => {
    // The W6 obligation is one declaration per family; the two lists are
    // disjoint so V-6/G8 have a single source for the door name.
    const broken: ArchManifest = {
      ...manifest,
      contractFamilyRoots: ["packages/core/src/contracts/run-context"],
    };

    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain(
      "contract-family-declared-twice",
    );
  });

  it("fails loudly for a duplicate pending contract family", () => {
    const broken: ArchManifest = {
      ...manifest,
      contractFamilyRoots: [
        "packages/core/src/contracts/agents",
        "packages/core/src/contracts/agents",
      ],
    };

    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain(
      "contract-family-duplicate",
    );
  });

  it("fails loudly for a forbidden peer pair outside its rank", () => {
    const broken: ArchManifest = {
      ...manifest,
      ranks: manifest.ranks.map((layer) =>
        layer.rank === 2
          ? { ...layer, forbiddenPeers: [{ from: "providers" as const, to: "execution" as const }] }
          : layer,
      ),
    };

    const problems = manifestProblems(broken, REPO_ROOT);

    expect(problemCodes(problems)).toContain("rank-forbidden-peer-foreign");
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      'forbids a peer import involving "execution", which rank 2 does not declare',
    );
  });

  it("fails loudly for a self-pair and a duplicate forbidden peer pair", () => {
    const selfPair: ArchManifest = {
      ...manifest,
      ranks: manifest.ranks.map((layer) =>
        layer.rank === 2
          ? { ...layer, forbiddenPeers: [{ from: "providers" as const, to: "providers" as const }] }
          : layer,
      ),
    };
    expect(problemCodes(manifestProblems(selfPair, REPO_ROOT))).toContain(
      "rank-forbidden-peer-self",
    );

    const duplicatePair: ArchManifest = {
      ...manifest,
      ranks: manifest.ranks.map((layer) =>
        layer.rank === 2
          ? {
              ...layer,
              forbiddenPeers: [
                { from: "providers" as const, to: "run-store" as const },
                { from: "run-store" as const, to: "providers" as const },
              ],
            }
          : layer,
      ),
    };
    expect(problemCodes(manifestProblems(duplicatePair, REPO_ROOT))).toContain(
      "rank-forbidden-peer-duplicate",
    );
  });

  it("fails loudly when a group is re-ranked into another rank's docGroups", () => {
    // The reviewer's mutation: `mcp` normally targets `providers` (rank 2);
    // pointing it at `execution` (rank 3) must be a problem.
    const reranked: ArchManifest = {
      ...manifest,
      ranks: manifest.ranks.map((layer) =>
        layer.rank === 2
          ? {
              ...layer,
              groups: layer.groups.map((group) =>
                group.name === "mcp" ? { ...group, targetGroup: "execution" as const } : group,
              ),
            }
          : layer,
      ),
    };

    const problems = manifestProblems(reranked, REPO_ROOT);

    expect(problemCodes(problems)).toContain("rank-target-foreign");
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      'group "mcp" targets "execution", which rank 2 does not declare',
    );
  });

  it("fails loudly when a docGroup is declared by more than one rank", () => {
    const duplicated: ArchManifest = {
      ...manifest,
      ranks: manifest.ranks.map((layer) =>
        layer.rank === 1
          ? { ...layer, docGroups: [...layer.docGroups, "contracts" as const] }
          : layer,
      ),
    };

    expect(problemCodes(manifestProblems(duplicated, REPO_ROOT))).toContain(
      "rank-docgroup-duplicate",
    );
  });

  it("fails loudly when a rank owns no groups", () => {
    const emptyRank: ArchManifest = {
      ...manifest,
      ranks: manifest.ranks.map((layer) => (layer.rank === 1 ? { ...layer, groups: [] } : layer)),
    };

    expect(problemCodes(manifestProblems(emptyRank, REPO_ROOT))).toContain("rank-groups-empty");
  });

  it("fails loudly for an exemption path that does not resolve", () => {
    const broken: ArchManifest = {
      ...manifest,
      exemptions: [
        {
          rule: "G8",
          path: "packages/dashboard/does-not-exist",
          reason: "fixture: an invented exemption",
        },
      ],
    };

    const problems = manifestProblems(broken, REPO_ROOT);

    expect(problemCodes(problems)).toContain("exemption-path-missing");
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      '"packages/dashboard/does-not-exist" does not exist',
    );
  });

  it("fails loudly for an exemption without a reason", () => {
    const broken: ArchManifest = {
      ...manifest,
      exemptions: [{ rule: "G8", path: "packages/dashboard", reason: "   " }],
    };

    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain("exemption-reason-missing");
  });

  it("fails loudly when a strict rule loses its fix recipe", () => {
    const broken: ArchManifest = {
      ...manifest,
      rules: {
        ...manifest.rules,
        G1: { ...manifest.rules.G1, fix: "" },
      },
    };

    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain("rule-fix-missing");
    expect(() => assertManifestValid(broken, REPO_ROOT)).toThrowError(/rule-fix-missing/);
  });

  it("fails loudly when ruleOrder and the rule table disagree", () => {
    const missingFromTable = Object.fromEntries(
      Object.entries(manifest.rules).filter(([ruleId]) => ruleId !== "G1"),
    ) as unknown as Readonly<Record<RuleId, RuleSpec>>;
    const withoutG1: ArchManifest = { ...manifest, rules: missingFromTable };

    expect(problemCodes(manifestProblems(withoutG1, REPO_ROOT))).toContain("rule-missing");

    const withoutG1Order: ArchManifest = {
      ...manifest,
      ruleOrder: manifest.ruleOrder.filter((ruleId) => ruleId !== "G1"),
    };

    expect(problemCodes(manifestProblems(withoutG1Order, REPO_ROOT))).toContain("rule-unlisted");
  });

  it("fails loudly for malformed rule conventions", () => {
    const emptyFolder: ArchManifest = {
      ...manifest,
      conventions: { ...manifest.conventions, internalFolder: "" },
    };
    expect(problemCodes(manifestProblems(emptyFolder, REPO_ROOT))).toContain("convention-empty");

    const duplicateNames: ArchManifest = {
      ...manifest,
      conventions: {
        ...manifest.conventions,
        bannedFolderNames: ["utils", "utils"],
      },
    };
    expect(problemCodes(manifestProblems(duplicateNames, REPO_ROOT))).toContain(
      "convention-list-duplicate",
    );

    const lowThreshold: ArchManifest = {
      ...manifest,
      conventions: { ...manifest.conventions, repeatedPrefixThreshold: 1 },
    };
    expect(problemCodes(manifestProblems(lowThreshold, REPO_ROOT))).toContain(
      "convention-threshold-invalid",
    );

    const badSuffix: ArchManifest = {
      ...manifest,
      conventions: { ...manifest.conventions, testSuffix: "test" },
    };
    expect(problemCodes(manifestProblems(badSuffix, REPO_ROOT))).toContain(
      "convention-suffix-invalid",
    );

    const pathAsName: ArchManifest = {
      ...manifest,
      conventions: { ...manifest.conventions, reservedFilenames: ["src/index.ts"] },
    };
    expect(problemCodes(manifestProblems(pathAsName, REPO_ROOT))).toContain(
      "convention-not-a-name",
    );

    // A `/` entry can never equal a folder basename, so it silently disables
    // S-5 (banned names) or the fixture exemption (G5/T rules).
    const bannedPath: ArchManifest = {
      ...manifest,
      conventions: { ...manifest.conventions, bannedFolderNames: ["src/utils"] },
    };
    expect(problemCodes(manifestProblems(bannedPath, REPO_ROOT))).toContain(
      "convention-not-a-name",
    );

    const fixturePath: ArchManifest = {
      ...manifest,
      conventions: { ...manifest.conventions, fixtureFolderNames: ["src/fixtures"] },
    };
    expect(problemCodes(manifestProblems(fixturePath, REPO_ROOT))).toContain(
      "convention-not-a-name",
    );
  });

  it("fails loudly when the normative doc URI is missing", () => {
    const broken: ArchManifest = { ...manifest, docUri: "  " };
    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain("doc-uri-missing");
  });

  it("fails loudly for a demotion below the noise threshold", () => {
    const broken: ArchManifest = {
      ...manifest,
      demotions: [
        {
          rule: "G1",
          from: "strict",
          to: "report",
          noiseCount: 1,
          reason: "fixture: one noisy PR",
          reviewedCommit: "0000000",
        },
      ],
    };

    expect(problemCodes(manifestProblems(broken, REPO_ROOT))).toContain(
      "demotion-noise-below-threshold",
    );
  });

  it("accepts a demotion that satisfies the protocol", () => {
    const reviewed: ArchManifest = {
      ...manifest,
      demotions: [
        {
          rule: "G1",
          from: "strict",
          to: "report",
          noiseCount: manifest.demotionProtocol.minimumNoiseCount,
          reason: "fixture: measured noise across reviewed changes",
          reviewedCommit: "0000000",
        },
      ],
    };

    expect(manifestProblems(reviewed, REPO_ROOT)).toEqual([]);
  });
});
