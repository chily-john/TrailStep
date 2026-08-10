---
kind: rules
paths:
  - .changeset/
summary: Changesets configuration for public package versioning and release preparation.
triggers:
  - changeset
  - release versioning
  - package publishing
  - npm release
---

# .changeset/

Enter here when changing Changesets release/versioning behavior for the workspace package set.

## Files

- `config.json`: Change when release base branch, changelog behavior, public access, internal dependency update policy, or ignored packages change.

## Rules

- Keep scoped packages public unless the package publication strategy changes across documentation and package metadata verification.
- Do not ignore workspace packages casually; verification expects the workspace package set to participate.
- Root scripts prepare/version releases, while `.github/workflows/release.yml` owns the manual publish workflow.
