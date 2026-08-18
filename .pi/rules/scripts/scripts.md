---
kind: rules
paths:
  - scripts/
summary: Repository scripts for public package readiness and local artifact hygiene.
triggers:
  - repository checks
  - package metadata
  - public package dry-run
  - local artifacts
---

# scripts/

Enter here when changing repository scripts for public package readiness or local artifact hygiene.

## Files

- `check-public-package-metadata.mjs`: Update when package set, package names, public package version policy, publish metadata, Changesets config, package files, CLI binary exposure, or workspace/peer dependency invariants change.
- `pack-public-packages.mjs`: Update when the public package set, packed required files, generated-output expectations, or forbidden local artifact patterns change.
- `check-local-artifact-ignore.mjs`: Update when local runtime/agent artifact paths, `.gitignore` requirements, or package `files` exclusions change.

## Rules

- Keep checks deterministic and based on committed files or npm dry-run output.
- If a package metadata, packaging, version-policy, or artifact-ignore invariant changes intentionally, update the matching verification script in the same change.
