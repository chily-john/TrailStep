import { describe, expect, it } from "vitest";
import { CliUsageError, helpText, parseCliArgs } from "./cli-args.js";

function parseError(argv: readonly string[]): string {
  try {
    parseCliArgs(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError);
    return error instanceof Error ? error.message : "";
  }
  throw new Error(`expected ${argv.join(" ")} to fail`);
}

describe("architecture CLI argument parsing", () => {
  it("defaults to report mode with the human format", () => {
    expect(parseCliArgs([])).toEqual({
      mode: "report",
      format: "human",
      rule: null,
      out: null,
      base: null,
      help: false,
    });
  });

  it("parses both scopes and both machine formats", () => {
    expect(parseCliArgs(["--changed", "--json"])).toMatchObject({
      mode: "changed",
      format: "json",
    });
    expect(parseCliArgs(["--report", "--sarif"])).toMatchObject({
      mode: "report",
      format: "sarif",
    });
  });

  it("parses the blocking full-tree check mode with --out", () => {
    expect(parseCliArgs(["--check"])).toMatchObject({ mode: "check" });
    expect(parseCliArgs(["--check", "--json", "--out", "/tmp/check.json"])).toMatchObject({
      mode: "check",
      format: "json",
      out: "/tmp/check.json",
    });
  });

  it("parses the explainer rule both inline and as the next argument", () => {
    expect(parseCliArgs(["--explain", "G8"])).toMatchObject({ mode: "explain", rule: "G8" });
    expect(parseCliArgs(["--explain=G8"])).toMatchObject({ mode: "explain", rule: "G8" });
  });

  it("parses --out for report mode", () => {
    expect(parseCliArgs(["--report", "--out", "/tmp/scorecard.json"])).toMatchObject({
      out: "/tmp/scorecard.json",
    });
  });

  it("parses --base for changed mode both inline and as the next argument", () => {
    expect(parseCliArgs(["--changed", "--base", "origin/main"])).toMatchObject({
      mode: "changed",
      base: "origin/main",
    });
    expect(parseCliArgs(["--changed", "--base=origin/main"])).toMatchObject({
      mode: "changed",
      base: "origin/main",
    });
    expect(parseCliArgs(["--base", "abc123", "--changed"])).toMatchObject({
      mode: "changed",
      base: "abc123",
    });
  });

  it("rejects conflicting modes and formats", () => {
    expect(parseError(["--report", "--changed"])).toContain("mutually exclusive");
    expect(parseError(["--check", "--report"])).toContain("mutually exclusive");
    expect(parseError(["--check", "--changed"])).toContain("mutually exclusive");
    expect(parseError(["--json", "--sarif"])).toContain("mutually exclusive");
    expect(parseError(["--explain", "G8", "--json"])).toContain("not valid with --explain");
    expect(parseError(["--check", "--explain", "G8"])).toContain("cannot be combined");
    expect(parseError(["--check", "--emit-skill", "x.md"])).toContain("cannot be combined");
  });

  it("rejects missing values, stray arguments, and --out outside report mode", () => {
    expect(parseError(["--explain"])).toContain("requires a value");
    expect(parseError(["--out"])).toContain("requires a value");
    expect(parseError(["--base"])).toContain("requires a value");
    expect(parseError(["--changed", "--out", "/tmp/x.json"])).toContain(
      "only valid in report or check mode",
    );
    expect(parseError(["--report", "--base", "origin/main"])).toContain(
      "only valid in changed mode",
    );
    expect(parseError(["--explain", "G8", "--base", "origin/main"])).toContain(
      "only valid in changed mode",
    );
    expect(parseError(["--wat"])).toContain('unknown flag "--wat"');
    expect(parseError(["G8"])).toContain('unexpected argument "G8"');
  });

  it("returns help without requiring other flags", () => {
    expect(parseCliArgs(["--help"])).toMatchObject({ help: true });
    expect(parseCliArgs(["-h"])).toMatchObject({ help: true });
  });

  it("documents the changed-file base rule and the artifact path", () => {
    const help = helpText();
    expect(help).toContain("HEAD (dirty working tree)");
    expect(help).toContain("merge-base HEAD");
    expect(help).toContain("--base <ref>");
    expect(help).toContain("never a HEAD-only fallback");
    expect(help).toContain(".trailstep/arch/architecture-scorecard.json");
    expect(help).toContain("There are no per-rule flags");
    expect(help).toContain("--check");
    expect(help).toContain("Full-tree blocking gate");
  });
});
