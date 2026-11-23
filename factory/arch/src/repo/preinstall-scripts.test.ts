import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  importedSpecifiers,
  preinstallScriptPaths,
  relativeSpecifiers,
} from "./preinstall-scripts.js";
import { findRepoRoot } from "./root.js";

/** `scripts/` holds one language: TypeScript, executed through Node type stripping. */
const SCRIPT_EXTENSIONS = [".ts"];

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
  return scriptEntries().filter((file) =>
    SCRIPT_EXTENSIONS.some((extension) => file.endsWith(extension)),
  );
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

    // A scan over zero files would pass vacuously; the five entry points are the floor.
    expect(files.length).toBe(5);

    const failures = files.flatMap((file) => {
      const specifiers = relativeSpecifiers(readFileSync(join(repoRoot, file), "utf8"));
      return specifiers.map((specifier) => relativeSpecifierFailure(file, specifier));
    });

    expect(failures.join("\n")).toBe("");
  });

  it("has no .mjs files under scripts", () => {
    expect(scriptEntries().filter((file) => file.endsWith(".mjs"))).toEqual([]);
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
