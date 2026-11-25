import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ArchManifest, RuleSpec } from "./manifest.js";
import { manifest } from "./manifest.js";
import {
  readCommittedSkill,
  renderSkill,
  SKILL_ARTIFACT_PATH,
  skillArtifactPath,
  writeSkill,
} from "./skill.js";

/**
 * Story 110's drift guard.
 *
 * The skill is generated from the manifest, so the only failure mode that
 * matters is a manifest edit that never reached the artifact: an agent would
 * then read a rule list that the checker no longer enforces. This test is the
 * byte comparison that makes that edit impossible to merge, plus the two
 * probes that prove the comparison is not vacuous (a manifest change must
 * change the rendered text) and that the artifact is where the harness looks.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const STRICT_RULE_IDS = manifest.ruleOrder.filter(
  (rule) => manifest.rules[rule].severity === "strict",
);

const REPORT_RULE_IDS = manifest.ruleOrder.filter(
  (rule) => manifest.rules[rule].severity === "report",
);

const REVIEW_RULE_IDS = manifest.ruleOrder.filter(
  (rule) => manifest.rules[rule].severity === "review",
);

/** A manifest superset: the red phase without touching the real manifest. */
function withExtraStrictRule(rule: string, spec: RuleSpec): ArchManifest {
  return {
    ...manifest,
    rules: { ...manifest.rules, [rule]: spec },
    ruleOrder: [...manifest.ruleOrder, rule],
  } as unknown as ArchManifest;
}

describe("generated architecture skill", () => {
  it("is byte-identical to the committed artifact", () => {
    expect(renderSkill(manifest)).toBe(readCommittedSkill(REPO_ROOT));
  });

  it("represents a manifest change without regeneration as drift", () => {
    const mutated = renderSkill(
      withExtraStrictRule("G9", {
        severity: "strict",
        anchor: "G9 | Drift probe",
        fix: "Fix the drift probe rule.",
      }),
    );

    // The rendered text changed, so the committed artifact would no longer match.
    expect(mutated).not.toBe(readCommittedSkill(REPO_ROOT));
    expect(mutated).toContain("`G9`");
    // Re-severitying an existing rule must also be visible.
    const demoted = renderSkill(
      withExtraStrictRule("G1", {
        ...manifest.rules.G1,
        severity: "report",
      }),
    );
    expect(demoted).not.toContain("- `G1`");
  });

  it("is the only sanctioned copy, at the harness's project skill path", () => {
    expect(SKILL_ARTIFACT_PATH).toBe(".agents/skills/trailstep-architecture/SKILL.md");
    expect(skillArtifactPath("/repo")).toBe(
      path.join("/repo", ".agents", "skills", "trailstep-architecture", "SKILL.md"),
    );
  });

  it("carries the command and state contract, not rule prose", () => {
    const text = readCommittedSkill(REPO_ROOT);
    for (const contract of [
      "pnpm arch:check --changed",
      "pnpm arch:check --check",
      "pnpm arch:check",
      "pnpm arch:explain",
      "pnpm verify:quick",
      "the fast loop: full-tree lint plus `arch:check --changed`",
      "pnpm verify",
      "Run `pnpm verify` before declaring done.",
      "It is not a typecheck substitute.",
      "`--changed` blocks on touched files; `--check` blocks on the full tree",
      "there is no `--skip <rule>`",
      manifest.docUri,
    ]) {
      expect(text).toContain(contract);
    }
    expect(text.startsWith("---\nname: trailstep-architecture\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("carries no normative-doc prose, only the pointer to it", () => {
    // The artifact may cite the normative doc's URI, never restate its prose.
    // These are distinctive sentences from
    // `viking://resources/trailstep/docs/architecture/codebase-architecture.md`
    // (§1 change invariant, §1.1 why this repo, §2 graph-is-truth); a copy-paste
    // of doc paragraphs into the generator would smuggle exactly this text in.
    const text = readCommittedSkill(REPO_ROOT);
    for (const prose of [
      "the cost of the next change",
      "Ambiguity is expensive",
      "The import graph is the evidence",
    ]) {
      expect(text).not.toContain(prose);
    }
  });

  it("lists every strict rule ID with its manifest fix recipe verbatim", () => {
    const text = readCommittedSkill(REPO_ROOT);
    expect(STRICT_RULE_IDS.length).toBeGreaterThan(0);
    for (const rule of STRICT_RULE_IDS) {
      expect(text).toContain(`- \`${rule}\` — ${manifest.rules[rule].fix}`);
    }
    for (const rule of REPORT_RULE_IDS) {
      expect(text).toContain(`\`${rule}\``);
    }
    for (const rule of REVIEW_RULE_IDS) {
      expect(text).toContain(`\`${rule}\``);
    }
    // No strict rule may appear as a report/review entry.
    for (const rule of STRICT_RULE_IDS) {
      expect(text).not.toContain(`Report-only (visible, never blocking): ${rule}`);
    }
  });

  it("writes the same bytes the renderer returns", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "trailstep-skill-"));
    try {
      const target = path.join(directory, "nested", "SKILL.md");
      const bytes = writeSkill(manifest, target);
      expect(bytes).toBe(Buffer.byteLength(renderSkill(manifest), "utf8"));
      expect(await readFile(target, "utf8")).toBe(renderSkill(manifest));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
