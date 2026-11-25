/**
 * SARIF 2.1.0 rendering for the architecture findings (Story 106).
 *
 * One result per violation, the diagnostic's rule ID as `ruleId`, and the
 * manifest's one-line fix recipe in the message. Severity maps to SARIF levels:
 * strict → error (blocking), report/review → note (never blocks). This mapping
 * resolves the recorded §9.1 "error" wording gap: the diagnostic contract says
 * `strict`, the CI format needs `error`.
 *
 * Operational findings (an unresolved import) are not manifest rules. They use
 * their own stable `ARCH-RESOLVE` rule in the SARIF driver and are always
 * `error`: an unresolvable edge cannot be architecture-checked.
 */

import type { ArchManifest, RuleId } from "./arch/manifest.js";
import {
  type CheckFinding,
  type Diagnostic,
  isOperationalDiagnostic,
  type OperationalDiagnostic,
} from "./arch/rules/index.js";

export type SarifLevel = "error" | "note";

export function sarifLevel(
  severity: Diagnostic["severity"] | OperationalDiagnostic["severity"],
): SarifLevel {
  return severity === "strict" || severity === "error" ? "error" : "note";
}

function helpUri(manifest: ArchManifest, ruleId: RuleId): string {
  return `${manifest.docUri}#${encodeURIComponent(manifest.rules[ruleId].anchor)}`;
}

function archSarifRule(manifest: ArchManifest, ruleId: RuleId): Record<string, unknown> {
  return {
    id: ruleId,
    name: ruleId,
    shortDescription: { text: manifest.rules[ruleId].fix },
    helpUri: helpUri(manifest, ruleId),
  };
}

function operationalSarifRule(diagnostic: OperationalDiagnostic): Record<string, unknown> {
  return {
    id: diagnostic.code,
    name: diagnostic.code,
    shortDescription: { text: diagnostic.fix },
    properties: { kind: "operational" },
  };
}

function sarifLocation(
  finding: Pick<Diagnostic, "file" | "line" | "column">,
): Record<string, unknown> {
  const physicalLocation: Record<string, unknown> = {
    artifactLocation: { uri: finding.file, uriBaseId: "%SRCROOT%" },
  };
  if (finding.line !== null) {
    physicalLocation.region = {
      startLine: finding.line,
      startColumn: finding.column ?? 1,
    };
  }
  return { physicalLocation };
}

function findingRuleId(finding: CheckFinding): string {
  return isOperationalDiagnostic(finding) ? finding.code : finding.rule;
}

function sarifResult(
  finding: CheckFinding,
  ruleIndex: ReadonlyMap<string, number>,
): Record<string, unknown> {
  return {
    ruleId: findingRuleId(finding),
    ruleIndex: ruleIndex.get(findingRuleId(finding)) ?? 0,
    level: sarifLevel(finding.severity),
    message: { text: `${finding.message} Fix: ${finding.fix}` },
    locations: [sarifLocation(finding)],
  };
}

/**
 * Deterministic SARIF document: manifest rules follow the manifest order,
 * operational codes follow the manifest rules in sorted order, results keep
 * the finding order, and JSON is pretty-printed so CI diffs stay readable.
 */
export function renderSarif(manifest: ArchManifest, findings: readonly CheckFinding[]): string {
  const presentRules = new Set(
    findings
      .filter((finding): finding is Diagnostic => !isOperationalDiagnostic(finding))
      .map((finding) => finding.rule),
  );
  const operationalByCode = new Map<string, OperationalDiagnostic>();
  for (const finding of findings) {
    if (isOperationalDiagnostic(finding) && !operationalByCode.has(finding.code)) {
      operationalByCode.set(finding.code, finding);
    }
  }

  const ruleIds = manifest.ruleOrder.filter((ruleId) => presentRules.has(ruleId));
  const operationalEntries = [...operationalByCode.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const allRuleIds = [...ruleIds, ...operationalEntries.map(([code]) => code)];
  const ruleIndex = new Map<string, number>(allRuleIds.map((ruleId, index) => [ruleId, index]));

  const sarif = {
    // biome-ignore lint/style/useNamingConvention: SARIF requires the "$schema" key.
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "trailstep-arch",
            informationUri: manifest.docUri,
            rules: [
              ...ruleIds.map((ruleId) => archSarifRule(manifest, ruleId)),
              ...operationalEntries.map(([, diagnostic]) => operationalSarifRule(diagnostic)),
            ],
          },
        },
        results: findings.map((finding) => sarifResult(finding, ruleIndex)),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
