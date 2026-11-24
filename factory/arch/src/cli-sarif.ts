/**
 * SARIF 2.1.0 rendering for the architecture diagnostics (Story 106).
 *
 * One result per violation, the diagnostic's rule ID as `ruleId`, and the
 * manifest's one-line fix recipe in the message. Severity maps to SARIF levels:
 * strict → error (blocking), report/review → note (never blocks). This mapping
 * resolves the recorded §9.1 "error" wording gap: the diagnostic contract says
 * `strict`, the CI format needs `error`.
 */

import type { ArchManifest, RuleId } from "./arch/manifest.js";
import type { Diagnostic } from "./arch/rules/index.js";

export type SarifLevel = "error" | "note";

export function sarifLevel(severity: Diagnostic["severity"]): SarifLevel {
  return severity === "strict" ? "error" : "note";
}

function helpUri(manifest: ArchManifest, ruleId: RuleId): string {
  return `${manifest.docUri}#${encodeURIComponent(manifest.rules[ruleId].anchor)}`;
}

function sarifRule(manifest: ArchManifest, ruleId: RuleId): Record<string, unknown> {
  return {
    id: ruleId,
    name: ruleId,
    shortDescription: { text: manifest.rules[ruleId].fix },
    helpUri: helpUri(manifest, ruleId),
  };
}

function sarifLocation(diagnostic: Diagnostic): Record<string, unknown> {
  const physicalLocation: Record<string, unknown> = {
    artifactLocation: { uri: diagnostic.file, uriBaseId: "%SRCROOT%" },
  };
  if (diagnostic.line !== null) {
    physicalLocation.region = {
      startLine: diagnostic.line,
      startColumn: diagnostic.column ?? 1,
    };
  }
  return { physicalLocation };
}

function sarifResult(
  diagnostic: Diagnostic,
  ruleIndex: ReadonlyMap<RuleId, number>,
): Record<string, unknown> {
  return {
    ruleId: diagnostic.rule,
    ruleIndex: ruleIndex.get(diagnostic.rule) ?? 0,
    level: sarifLevel(diagnostic.severity),
    message: { text: `${diagnostic.message} Fix: ${diagnostic.fix}` },
    locations: [sarifLocation(diagnostic)],
  };
}

/**
 * Deterministic SARIF document: rules follow the manifest order, results keep
 * the diagnostic order, and JSON is pretty-printed so CI diffs stay readable.
 */
export function renderSarif(manifest: ArchManifest, diagnostics: readonly Diagnostic[]): string {
  const present = new Set(diagnostics.map((diagnostic) => diagnostic.rule));
  const ruleIds = manifest.ruleOrder.filter((ruleId) => present.has(ruleId));
  const ruleIndex = new Map<RuleId, number>(ruleIds.map((ruleId, index) => [ruleId, index]));

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
            rules: ruleIds.map((ruleId) => sarifRule(manifest, ruleId)),
          },
        },
        results: diagnostics.map((diagnostic) => sarifResult(diagnostic, ruleIndex)),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
