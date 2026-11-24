import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describePackageExportsViolations,
  EXPORT_SURFACE_EXEMPTIONS,
  type PackageExportsShape,
  packageExportsViolations,
} from "./package-exports.js";
import { findRepoRoot } from "./root.js";

const repoRoot = findRepoRoot();

/** A workspace package directory and its parsed manifest. */
interface PackageManifestShape {
  directory: string;
  manifest: PackageExportsShape;
}

const CLEAN_EXPORTS = {
  ".": {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  },
};

/** Every directory under `packages/` that holds a package manifest. */
function packageManifests(): PackageManifestShape[] {
  return readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const directory = `packages/${entry.name}`;
      let source: string;

      try {
        source = readFileSync(join(repoRoot, directory, "package.json"), "utf8");
      } catch {
        return [];
      }

      const manifest = JSON.parse(source) as PackageExportsShape;

      return [{ directory, manifest }];
    })
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

function publicPackageManifests(): PackageManifestShape[] {
  return packageManifests().filter(({ manifest }) => manifest.private !== true);
}

function violationKeys(
  shape: PackageExportsShape,
  exemptions = EXPORT_SURFACE_EXEMPTIONS,
): string[] {
  return packageExportsViolations(shape, exemptions).map((violation) => violation.key);
}

function messageFor(shape: PackageExportsShape): string {
  return describePackageExportsViolations(
    "packages/fixture/package.json",
    packageExportsViolations(shape),
  );
}

describe("public package exports", () => {
  it("keeps every public package export surface at `.`", () => {
    const packages = publicPackageManifests();
    expect(packages.length).toBeGreaterThan(0);

    const failures = packages.flatMap(({ directory, manifest }) => {
      const violations = packageExportsViolations(manifest);

      return violations.length === 0
        ? []
        : [describePackageExportsViolations(`${directory}/package.json`, violations)];
    });

    expect(failures.join("\n")).toBe("");
  });

  it("documents exactly one exemption with a reason", () => {
    expect(EXPORT_SURFACE_EXEMPTIONS).toHaveLength(1);

    const [exemption] = EXPORT_SURFACE_EXEMPTIONS;
    expect(exemption?.packageName).toBe("@trailstep/mcp");
    expect(exemption?.exportKey).toBe("./package.json");
    expect(exemption?.reason.trim().length).toBeGreaterThan(0);

    const exemptPackage = packageManifests().find(
      ({ manifest }) => manifest.name === exemption?.packageName,
    );
    expect(exemptPackage?.directory).toBe("packages/mcp");
    expect(exemptPackage?.manifest.private).not.toBe(true);
  });

  it("accepts the sanctioned `.` surface", () => {
    expect(violationKeys({ name: "@trailstep/fixture", exports: CLEAN_EXPORTS })).toEqual([]);
  });

  it("rejects a deep subpath export with the reach-in rationale", () => {
    const shape = {
      name: "@trailstep/fixture",
      exports: {
        ...CLEAN_EXPORTS,
        "./internal": "./dist/internal.js",
      },
    };

    expect(violationKeys(shape)).toEqual(['exports["./internal"]']);

    const message = messageFor(shape);
    expect(message).toContain(
      'packages/fixture/package.json: exports["./internal"] is "./dist/internal.js"',
    );
    expect(message).toContain('deep reach-ins such as "@trailstep/fixture/internal"');
    expect(message).toContain('rootDir: "src" blocks relative source reach-ins');
  });

  it("rejects ./package.json unless the package is exempt", () => {
    const shape = {
      name: "@trailstep/fixture",
      exports: { ...CLEAN_EXPORTS, "./package.json": "./package.json" },
    };

    expect(violationKeys(shape)).toEqual(['exports["./package.json"]']);
    expect(messageFor(shape)).toContain("./package.json");
  });

  it("honours the recorded packages/mcp exemption", () => {
    const shape = {
      name: "@trailstep/mcp",
      exports: { ...CLEAN_EXPORTS, "./package.json": "./package.json" },
    };

    expect(violationKeys(shape)).toEqual([]);
    expect(violationKeys(shape, [])).toEqual(['exports["./package.json"]']);
  });

  it("uses its one exemption on the real packages/mcp manifest", () => {
    const mcp = packageManifests().find(({ directory }) => directory === "packages/mcp");
    expect(mcp).toBeDefined();

    if (mcp === undefined) {
      return;
    }

    expect(violationKeys(mcp.manifest, [])).toEqual(['exports["./package.json"]']);
    expect(violationKeys(mcp.manifest)).toEqual([]);
  });

  it("exempts private packages", () => {
    expect(
      violationKeys({
        name: "@trailstep/private",
        private: true,
        exports: { ...CLEAN_EXPORTS, "./internal": "./dist/internal.js" },
      }),
    ).toEqual([]);
  });

  it("rejects a missing or malformed exports field", () => {
    const missing = messageFor({ name: "@trailstep/fixture" });

    expect(violationKeys({ name: "@trailstep/fixture" })).toEqual(["exports"]);
    expect(missing).toContain("packages/fixture/package.json: exports is undefined");
    expect(missing).toContain("package.json#exports is what blocks deep reach-ins");

    expect(violationKeys({ name: "@trailstep/fixture", exports: ["./dist/index.js"] })).toEqual([
      "exports",
    ]);
  });

  it("requires the `.` entry point", () => {
    const shape = {
      name: "@trailstep/fixture",
      exports: { "./package.json": "./package.json" },
    };

    expect(violationKeys(shape)).toEqual(["exports", 'exports["./package.json"]']);
    expect(messageFor(shape)).toContain("without it the package has no public entry point");
  });
});
