# Agent guide

StepKit is a durable, typed, observable workflow harness for coding agents. It is a TypeScript-first pnpm monorepo and a clean-slate project separate from Workflower. Workflows are authored in TypeScript, discovered from packages, run through a continuation runtime, and observed through persisted local run artifacts.

This root context file contains a map of the codebase. The rest of the information — coding rules, directory-specific details, and inventories — lives in path-scoped context files under `.pi/rules/`.

Use injected `.pi/rules` context as the first source of project-specific guidance. Trust injected rules as current during normal implementation; if they do not answer where or how to proceed, inspect `.pi/rules` before broad source-code searches. Read source files to verify local style, existing APIs, or implementation details.

## Project Structure

```text
├── packages/             # Publishable workspace packages
│   ├── core/             # Framework-neutral runtime, shapes, continuation engine, events, agent targeting, provider CLI registry
│   ├── authoring/        # TypeScript authoring helpers layered over core primitives
│   ├── cli/              # `stepkit` workflow discovery, skill checks, config loading, and local execution command
│   ├── testkit/          # Workflow testing utilities package surface
│   └── dashboard/        # Svelte/Vite local workflow run observability UI
├── scripts/              # Repository invariant checks used locally and by CI
├── .github/              # CI, release, dependency review, CODEOWNERS, PR/branch-protection guidance
└── .changeset/           # Changesets release/versioning configuration
```

## Commands

- Install: `pnpm install`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`
- Build: `pnpm build`
- Format: `pnpm format`
- Verify repository docs: `node scripts/verify-repository-docs.mjs`
- Verify package metadata: `node scripts/verify-package-metadata.mjs`
- Verify GitHub config: `node scripts/verify-github-config.mjs`

## Environment

- Use Node 24 or newer.
- Use pnpm workspaces; packages live under `packages/*`.
- The intended remote documented by the project is `git@github-personal:chily-john/stepkit.git`.

## Gotchas

- Generated output (`dist/`, `.turbo/`, coverage, package `node_modules/`, `.stepkit/runs/`) is not source of truth.
- New workflows should use the continuation model: `defineWorkflow({ ... start })`, `step(...)`, and `done(...)`; do not expand the older static `steps: []` path.
- Living source and tests are authoritative when package README text or rules drift.
- Branch protection cannot be fully enforced from repository files; GitHub settings must be configured separately.
- Dependency review currently has `continue-on-error: true` intentionally while the project is early.
- Touched-package CI is not implemented; assume all-package checks are the safe validation path.
