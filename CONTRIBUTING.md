# Contributing to TrailStep

Thank you for helping improve TrailStep. This project welcomes issues, ideas, docs, tests, and pull requests, while keeping final product direction and releases under maintainer control.

## Ways to contribute

- Open an issue for bugs, confusing docs, rough edges, or feature ideas.
- Comment on existing issues with reproduction details, use cases, or design feedback.
- Submit small pull requests for docs, tests, bug fixes, and scoped improvements.
- Discuss larger changes before implementing them so we can avoid wasted effort.

## Before opening a pull request

1. Check existing issues and pull requests for overlap.
2. For user-facing features, API changes, workflow semantics, release behavior, or architecture changes, open an issue first and wait for maintainer direction.
3. Keep pull requests focused. Smaller PRs are much easier to review and merge.
4. Include tests or explain why tests are not practical for the change.
5. Update docs/examples when user-facing behavior changes.

## Local setup

TrailStep uses Node 24+ and pnpm workspaces.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Useful release/readiness checks:

```bash
pnpm check:public-packages
pnpm run pack:public:dry-run
node scripts/check-local-artifact-ignore.mjs
```

## Changesets and versioning

TrailStep uses Changesets for package versioning.

If your PR changes published package behavior, add a changeset:

```bash
pnpm changeset
```

Choose the version bump intentionally:

- `patch`: bug fixes, internal improvements, docs that affect published package metadata.
- `minor`: backwards-compatible features or new public capabilities.
- `major`: breaking API/CLI/workflow behavior changes.

When unsure, ask in the PR. Maintainers may edit or request changes to the changeset before release.

## Pull request expectations

A good PR includes:

- A short summary of what changed and why.
- Linked issue or context when applicable.
- Tests/docs updates when relevant.
- Validation results, especially `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Clear non-goals if the PR intentionally leaves something out.

## Maintainer control and project direction

Maintainers may close, redirect, or defer changes that do not fit the project direction, even if the implementation works. That is not a rejection of the contributor; it is how the project stays coherent.

Large changes should start with an issue or design discussion. Maintainers make final calls on scope, architecture, release timing, and compatibility policy.

## Contribution license

By contributing to this repository, you agree that your contributions are licensed under the same license as the project: Apache-2.0.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
