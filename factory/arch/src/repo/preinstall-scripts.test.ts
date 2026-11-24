import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  importedSpecifiers,
  preinstallScriptPaths,
  relativeSpecifiers,
  SCRIPT_ENTRYPOINT_FLOOR,
  scriptAllowlistViolations,
} from "./preinstall-scripts.js";
import { findRepoRoot } from "./root.js";

/** Relative imports are only meaningful in the TypeScript entry points. */
const TYPESCRIPT_EXTENSION = ".ts";

const repoRoot = findRepoRoot();

/** The rejection message the real-file scan reports: file, specifier, and fix. */
function relativeSpecifierFailure(file: string, specifier: string): string {
  return (
    `${file}: relative import "${specifier}". Fix: scripts/ entries run before pnpm install; ` +
    "use node: builtins only, and put multi-file maintenance code in factory/."
  );
}

/** Every file under `scripts/` (recursively), repo-relative. */
function scriptEntries(directory = "scripts"): string[] {
  return readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? scriptEntries(path) : [path];
  });
}

function scriptFiles(): string[] {
  return scriptEntries().filter((file) => file.endsWith(TYPESCRIPT_EXTENSION));
}

describe("pre-install scripts", () => {
  it("rejects a relative import in a pre-install script", () => {
    const source = 'import { readFileSync } from "./repo-files.js";\n';

    expect(relativeSpecifiers(source)).toEqual(["./repo-files.js"]);

    const [specifier] = relativeSpecifiers(source);
    const message = relativeSpecifierFailure("scripts/fixture.ts", specifier ?? "");
    expect(message).toContain("scripts/fixture.ts");
    expect(message).toContain("./repo-files.js");
    expect(message).toContain("Fix: scripts/ entries run before pnpm install");
    expect(message).toContain("put multi-file maintenance code in factory/");
  });

  it("rejects relative export-from specifiers too", () => {
    expect(relativeSpecifiers('export { x } from "../shared/x.js";')).toEqual(["../shared/x.js"]);
  });

  it("rejects side-effect relative imports", () => {
    expect(relativeSpecifiers('import "./secret.js";\n')).toEqual(["./secret.js"]);
    expect(relativeSpecifiers("import './single-quoted.js';\n")).toEqual(["./single-quoted.js"]);
  });

  it("rejects dynamic relative imports", () => {
    expect(relativeSpecifiers('const secret = await import("./secret.js");')).toEqual([
      "./secret.js",
    ]);
    expect(importedSpecifiers("const secret = await import( './secret.js' );")).toEqual([
      "./secret.js",
    ]);
  });

  it("accepts side-effect and dynamic node: imports", () => {
    expect(importedSpecifiers('import "node:fs";')).toEqual(["node:fs"]);
    expect(importedSpecifiers('const fs = await import("node:fs/promises");')).toEqual([
      "node:fs/promises",
    ]);
    expect(
      relativeSpecifiers('import "node:fs";\nconst fs = await import("node:fs/promises");'),
    ).toEqual([]);
  });

  it("returns one specifier per statement", () => {
    const source = [
      'import type { A } from "./a.js";',
      'import { b } from "../b.js";',
      'import "./side-effect.js";',
      'export * from "./re-export.js";',
      'const dynamic = await import("./dynamic.js");',
      'import { join } from "node:path";',
      "",
    ].join("\n");

    expect(importedSpecifiers(source)).toEqual([
      "./a.js",
      "../b.js",
      "./side-effect.js",
      "./re-export.js",
      "./dynamic.js",
      "node:path",
    ]);
  });

  it("accepts node: and bare specifiers", () => {
    expect(relativeSpecifiers('import { join } from "node:path";')).toEqual([]);
    expect(importedSpecifiers('import { join } from "node:path";')).toEqual(["node:path"]);
  });

  it("keeps every script free of relative specifiers", () => {
    const files = scriptFiles();

    // The allowlist guard pins the directory floor; this only needs a
    // non-vacuous TypeScript subset to scan.
    expect(files.length).toBeGreaterThan(0);

    const failures = files.flatMap((file) => {
      const specifiers = relativeSpecifiers(readFileSync(join(repoRoot, file), "utf8"));
      return specifiers.map((specifier) => relativeSpecifierFailure(file, specifier));
    });

    expect(failures.join("\n")).toBe("");
  });

  it("accepts TypeScript entry points and shell wrappers", () => {
    expect(
      scriptAllowlistViolations([
        "scripts/check-lockfile-sync.ts",
        "scripts/nested/helper.ts",
        "scripts/refresh-openviking-index.sh",
      ]),
    ).toEqual([]);
  });

  it.each([".js", ".cjs", ".mjs", ".mts"])("rejects a %s entry point", (extension) => {
    const file = `scripts/legacy${extension}`;
    const [violation] = scriptAllowlistViolations([file]);

    expect(violation?.file).toBe(file);
    expect(violation?.extension).toBe(extension);
    expect(violation?.message).toContain(`${file}: extension is ${JSON.stringify(extension)}`);
    expect(violation?.message).toContain("scripts/ holds one language");
    expect(violation?.message).toContain("put multi-file maintenance code in factory/");
  });

  it("rejects an extensionless script", () => {
    const [violation] = scriptAllowlistViolations(["scripts/legacy"]);

    expect(violation?.extension).toBe("(none)");
    expect(violation?.message).toContain("scripts/ holds one language");
  });

  it("holds only allowlisted script files", () => {
    const files = scriptEntries();
    const failures = scriptAllowlistViolations(files).map((violation) => violation.message);

    // Report the offending file and its fix before the count, so a hostile
    // addition fails with the ruling instead of a bare off-by-one.
    expect(failures.join("\n")).toBe("");
    expect(files.length).toBe(SCRIPT_ENTRYPOINT_FLOOR);
  });

  it("points every node scripts/ entry at an existing file", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const paths = preinstallScriptPaths(manifest.scripts ?? {});

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !existsSync(join(repoRoot, path)))).toEqual([]);
  });
});
