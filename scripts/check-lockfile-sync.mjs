// Verifies pnpm-lock.yaml importer specifiers match every workspace package.json.
//
// Catches manifest/lockfile drift locally and in CI *before* `pnpm install --frozen-lockfile`
// fails with a cryptic ERR_PNPM_OUTDATED_LOCKFILE. The two drift modes seen in practice:
//   - a manifest specifier changed without running `pnpm install` (lockfile stale)
//   - the lockfile regenerated on a dirty tree, so it records specifiers from uncommitted
//     package.json changes that are not part of the commit (lockfile over-recorded)
// Fix for both: run `pnpm install` on a CLEAN tree whose manifest changes are already
// committed, then commit the updated pnpm-lock.yaml.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const depGroups = ["dependencies", "devDependencies", "optionalDependencies"];

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseLockfileImporters(lockfileText) {
  const lines = lockfileText.split(/\r?\n/u);
  const importers = new Map();
  let inImporters = false;
  let currentImporter = null;
  let currentGroup = null;
  let currentDep = null;

  for (const line of lines) {
    if (/^importers:\s*$/u.test(line)) {
      inImporters = true;
      continue;
    }
    if (inImporters && line.length > 0 && !/^\s/u.test(line)) {
      break; // next top-level section (packages:, snapshots:, ...)
    }
    if (!inImporters) {
      continue;
    }

    const importerMatch = /^ {2}(.+):\s*$/u.exec(line);
    const groupMatch = /^ {4}(\S+):\s*$/u.exec(line);
    const depMatch = /^ {6}(.+):\s*$/u.exec(line);
    const specifierMatch = /^ {8}specifier:\s*(.+?)\s*$/u.exec(line);

    if (specifierMatch && currentDep) {
      currentDep.specifier = unquote(specifierMatch[1]);
      currentDep = null;
    } else if (depMatch && currentGroup) {
      currentDep = { name: unquote(depMatch[1]), specifier: null };
      currentGroup.set(currentDep.name, currentDep);
    } else if (groupMatch && currentImporter && depGroups.includes(groupMatch[1])) {
      currentGroup = new Map();
      currentImporter.set(groupMatch[1], currentGroup);
    } else if (importerMatch) {
      currentImporter = new Map();
      currentGroup = null;
      importers.set(unquote(importerMatch[1]), currentImporter);
    } else if (/^ {2}\S/u.test(line) || /^ {4}\S/u.test(line)) {
      currentGroup = null; // an unrelated key inside an importer
    }
  }

  return importers;
}

function workspacePackageDirectories() {
  const workspaceText = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [];
  let inPackages = false;
  for (const line of workspaceText.split(/\r?\n/u)) {
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/u.test(line)) {
      break;
    }
    const entry = inPackages && /^ {2}-\s*(.+?)\s*$/u.exec(line);
    if (entry) {
      globs.push(unquote(entry[1]));
    }
  }

  const directories = ["."]; // root importer
  for (const pattern of globs) {
    if (pattern.endsWith("/*")) {
      const parent = join(root, pattern.slice(0, -2));
      if (existsSync(parent)) {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(parent, entry.name, "package.json"))) {
            directories.push(`${pattern.slice(0, -2)}/${entry.name}`);
          }
        }
      }
    } else if (existsSync(join(root, pattern, "package.json"))) {
      directories.push(pattern);
    }
  }
  return directories.sort();
}

function manifestSpecifiers(manifest) {
  const specifiers = new Map();
  for (const group of depGroups) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      specifiers.set(`${group} > ${name}`, { name, group, specifier: String(range) });
    }
  }
  return specifiers;
}

function lockfileSpecifiers(importer) {
  const specifiers = new Map();
  for (const group of depGroups) {
    for (const dep of importer?.get(group)?.values() ?? []) {
      specifiers.set(`${group} > ${dep.name}`, { name: dep.name, group, specifier: dep.specifier });
    }
  }
  return specifiers;
}

const importers = parseLockfileImporters(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
const problems = [];

for (const directory of workspacePackageDirectories()) {
  const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
  const importerKey = directory === "." ? "." : directory.replaceAll("\\", "/");
  const manifestDeps = manifestSpecifiers(manifest);
  const lockfileDeps = lockfileSpecifiers(importers.get(importerKey));

  if (manifestDeps.size > 0 && !importers.has(importerKey)) {
    problems.push(`${importerKey}: missing from pnpm-lock.yaml importers entirely`);
    continue;
  }

  for (const [key, manifestDep] of manifestDeps) {
    const lockfileDep = lockfileDeps.get(key);
    if (!lockfileDep) {
      problems.push(
        `${importerKey}: ${manifestDep.group} > ${manifestDep.name} is in package.json (${manifestDep.specifier}) but missing from pnpm-lock.yaml`,
      );
    } else if (lockfileDep.specifier !== manifestDep.specifier) {
      problems.push(
        `${importerKey}: ${manifestDep.group} > ${manifestDep.name} specifier mismatch (lockfile: ${lockfileDep.specifier}, manifest: ${manifestDep.specifier})`,
      );
    }
  }
  for (const [key, lockfileDep] of lockfileDeps) {
    if (!manifestDeps.has(key)) {
      problems.push(
        `${importerKey}: ${lockfileDep.group} > ${lockfileDep.name} is in pnpm-lock.yaml (${lockfileDep.specifier}) but missing from package.json (lockfile regenerated from uncommitted manifest changes?)`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("pnpm-lock.yaml is out of sync with workspace manifests:");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error("");
  console.error(
    "Fix: commit manifest changes first, run `pnpm install` on a CLEAN tree, then commit pnpm-lock.yaml.",
  );
  process.exit(1);
}

console.log("pnpm-lock.yaml is in sync with all workspace manifests.");
