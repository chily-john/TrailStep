---
kind: rules
paths:
  - .github/
summary: GitHub repository ownership, issue and pull request expectations, CI, release, dependency automation, dependency review, and branch-protection notes.
triggers:
  - GitHub Actions
  - CI
  - release workflow
  - CODEOWNERS
  - issue template
  - pull request template
  - Dependabot
  - branch protection
  - pnpm version
---

# .github/

Enter here when changing repository automation or contributor workflow expectations.

## Files

- `CODEOWNERS`: Change when repository ownership/review requirements change.
- `pull_request_template.md`: Change when reviewer checklist expectations change.
- `ISSUE_TEMPLATE/config.yml`: Change when public issue routing or private security reporting guidance changes.
- `ISSUE_TEMPLATE/bug_report.yml`: Change when bug report intake requirements change.
- `ISSUE_TEMPLATE/feature_request.yml`: Change when feature proposal intake requirements change.
- `ISSUE_TEMPLATE/question.yml`: Change when question intake requirements change.
- `dependabot.yml`: Change when dependency update cadence, grouping, limits, or commit prefixes change.
- `branch-protection.md`: Change when administrator-facing GitHub branch protection setup changes.
- `workflows/ci.yml`: Change when all-package validation or supported tool versions change.
- `workflows/release.yml`: Change when Changesets release triggers or publish behavior change.
- `workflows/dependency-review.yml`: Change when dependency review policy changes; its non-blocking mode is intentional while the project is early.

## Rules

- Keep CI on all packages until dependency-aware touched-package builds are designed.
- Do not set an explicit `pnpm/action-setup` version in workflows; let the root `packageManager` field be the single pnpm version source.
- Do not claim branch protection is enforced by YAML alone.
- If a workflow changes, update `scripts/verify-github-config.mjs` when its asserted behavior changes.
