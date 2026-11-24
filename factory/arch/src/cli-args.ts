/**
 * Argument parsing for the architecture CLI (Story 106).
 *
 * The surface is deliberately small: two scopes (`--report`, `--changed`), two
 * machine formats (`--json`, `--sarif`), one explainer (`--explain <rule>`),
 * and one artifact path override (`--out <path>`). There are no per-rule
 * flags: severity lives in the manifest (parent §8.2), so a `--skip G1`-style
 * toggle has no place in this parser.
 */

export type CliMode = "report" | "changed" | "explain";
export type CliFormat = "human" | "json" | "sarif";

export interface CliOptions {
  readonly mode: CliMode;
  readonly format: CliFormat;
  readonly rule: string | null;
  readonly out: string | null;
  readonly help: boolean;
}

/** A command line the CLI refuses to run; the entrypoint exits 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const HELP = `trailstep architecture gate (Story 106)

Usage:
  pnpm arch:check [--report] [--json | --sarif] [--out <path>]
  pnpm arch:check --changed [--json | --sarif]
  pnpm arch:explain <rule>

Modes:
  --report        Full-tree scorecard (the default). Writes the scorecard JSON
                  artifact and always exits 0, even when the strict set is red.
  --changed       Runs the strict set scoped to the files this working tree or
                  branch touches. Exits 1 when a touched file violates a strict
                  rule. Report-only rules never block.
  --explain <id>  Prints one rule from the manifest: severity, doc anchor and
                  URI, fix recipe, legal targets, and a fixture-derived
                  good/bad example. An unknown rule ID exits 1.

Output:
  --json          Report mode prints the scorecard JSON (Story 105's golden
                  format); changed mode prints the scoped diagnostics as JSON.
  --sarif         Prints SARIF 2.1.0 for the selected diagnostics (one result
                  per violation, rule ID as ruleId, fix recipe in the message).
  --out <path>    Report-mode scorecard path. Relative paths resolve against
                  the current directory.

Scorecard artifact:
  Default: .trailstep/arch/architecture-scorecard.json (gitignored run output,
  never a committed path).

Changed-file rule:
  The file list is git's, with deleted files and non-TypeScript files excluded.
  - Dirty working tree: compare against HEAD (tracked modifications plus
    untracked, non-ignored files); the base is printed as
    "HEAD (dirty working tree)".
  - Clean working tree: compare against the merge base of HEAD and the
    upstream branch (or origin/main, main, origin/master, master); the base is
    printed as "merge-base HEAD <ref> (<sha>)".
  - No merge base (fresh branch, shallow clone): fall back to HEAD.
Changed-mode scope (the ratchet):
  Only debt the touched files' own edges and own folders introduce can block.
    file            G2 G8 S-6 M-6 T-1 T-2 N-1 block when the diagnostic names
                    a touched file.
    own folder      G5 (width budget) and S-5 (banned capability name) block
                    only when the touched file's own folder (dirname) is the
                    violated folder, never an ancestor folder.
    importer        G4 blocks when a touched file is one of the importers that
                    make the flagged folder an NCA case.
    edge cycle      G1 blocks only when a touched file's own value/type edge
                    lies on a file cycle; living inside a cyclic group does
                    not block.
    report surface  V-4, V-6 and S-9 are folder-shape/existence diagnostics:
                    they never block --changed and stay visible in the
                    full-tree report.
  Files outside the manifest's analyzed tree (today: packages/core/src)
  produce no strict violations; that is correct-by-manifest, not a silent
  pass.

Exit codes:
  0  report mode, or changed mode with no strict violation among touched files
  1  changed mode found a strict violation (or --explain got an unknown rule)
  2  usage or operational error

There are no per-rule flags. Severity lives in the manifest; use the demotion
protocol, never a CLI toggle.`;

export function helpText(): string {
  return HELP;
}

interface FlagValue {
  readonly value: string;
  readonly next: number;
}

function flagValue(
  argv: readonly string[],
  index: number,
  flag: string,
  inline: string | null,
): FlagValue {
  if (inline !== null) {
    if (inline === "") {
      throw new CliUsageError(`${flag} requires a value.`);
    }
    return { value: inline, next: index + 1 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("-")) {
    throw new CliUsageError(`${flag} requires a value.`);
  }
  return { value: next, next: index + 2 };
}

function splitFlag(argument: string): { name: string; inline: string | null } {
  const equals = argument.indexOf("=");
  if (equals === -1) {
    return { name: argument, inline: null };
  }
  return { name: argument.slice(0, equals), inline: argument.slice(equals + 1) };
}

/** Parses argv (without `node` and the script path). Throws `CliUsageError`. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let mode: CliMode = "report";
  let modeExplicit = false;
  let format: CliFormat = "human";
  let rule: string | null = null;
  let out: string | null = null;

  const setMode = (next: CliMode): void => {
    if (modeExplicit && mode !== next) {
      throw new CliUsageError("--report and --changed are mutually exclusive.");
    }
    mode = next;
    modeExplicit = true;
  };

  for (let index = 0; index < argv.length; ) {
    const argument = argv[index] ?? "";
    const { name, inline } = splitFlag(argument);

    switch (name) {
      case "--help":
      case "-h":
        return { mode, format, rule, out, help: true };
      case "--report":
        if (inline !== null) {
          throw new CliUsageError("--report takes no value.");
        }
        setMode("report");
        index += 1;
        break;
      case "--changed":
        if (inline !== null) {
          throw new CliUsageError("--changed takes no value.");
        }
        setMode("changed");
        index += 1;
        break;
      case "--explain": {
        if (modeExplicit && mode !== "explain") {
          throw new CliUsageError("--explain cannot be combined with another mode.");
        }
        const parsed = flagValue(argv, index, "--explain", inline);
        mode = "explain";
        modeExplicit = true;
        rule = parsed.value;
        index = parsed.next;
        break;
      }
      case "--json": {
        if (inline !== null) {
          throw new CliUsageError("--json takes no value.");
        }
        if (format !== "human" && format !== "json") {
          throw new CliUsageError("--json and --sarif are mutually exclusive.");
        }
        format = "json";
        index += 1;
        break;
      }
      case "--sarif": {
        if (inline !== null) {
          throw new CliUsageError("--sarif takes no value.");
        }
        if (format !== "human" && format !== "sarif") {
          throw new CliUsageError("--json and --sarif are mutually exclusive.");
        }
        format = "sarif";
        index += 1;
        break;
      }
      case "--out": {
        const parsed = flagValue(argv, index, "--out", inline);
        out = parsed.value;
        index = parsed.next;
        break;
      }
      default: {
        if (argument.startsWith("-")) {
          throw new CliUsageError(`unknown flag "${argument}".`);
        }
        if (mode === "explain" && rule === null) {
          rule = argument;
          index += 1;
          break;
        }
        throw new CliUsageError(`unexpected argument "${argument}".`);
      }
    }
  }

  if (mode === "explain" && rule === null) {
    throw new CliUsageError("--explain requires a rule ID.");
  }
  if (mode !== "explain" && rule !== null) {
    throw new CliUsageError("a rule ID is only valid with --explain.");
  }
  if (out !== null && mode !== "report") {
    throw new CliUsageError("--out is only valid in report mode.");
  }
  if (mode === "explain" && format !== "human") {
    throw new CliUsageError("--json and --sarif are not valid with --explain.");
  }

  return { mode, format, rule, out, help: false };
}
