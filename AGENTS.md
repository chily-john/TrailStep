# Agent guide

StepKit is a durable, typed, observable workflow harness for coding agents. It is a TypeScript-first pnpm monorepo and a clean-slate project separate from Workflower. The v0 vertical slice is implemented for `core`, `sdk`, and `cli`; `testkit` and `dashboard` remain publish-ready scaffolds.

This root context file contains a map of the codebase. The rest of the information — coding rules, directory-specific details, and inventories — lives in path-scoped context files under `.pi/rules/`.

Use injected `.pi/rules` context as the first source of project-specific guidance. Trust injected rules as current during normal implementation; if they do not answer where or how to proceed, inspect `.pi/rules` before broad source-code searches. Read source files to verify local style, existing APIs, or implementation details.

## Project Structure

```text
├── docs/                 # Durable product direction, package boundaries, runtime/SDK decisions, roadmap
├── packages/             # Five publishable workspace packages: core, sdk, cli, testkit, dashboard
│   ├── core/             # Framework-neutral runtime, shapes, continuation engine, events, provider CLI registry
│   ├── sdk/              # TypeScript authoring helpers layered over core primitives
│   ├── cli/              # `stepkit` workflow discovery and local execution command
│   ├── testkit/          # Future behavior-focused workflow validation helpers; currently scaffolded
│   └── dashboard/        # Future Svelte/Vite observability UI; currently scaffolded
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
- Verify docs: `node scripts/verify-repository-docs.mjs`
- Verify package metadata: `node scripts/verify-package-metadata.mjs`
- Verify GitHub config: `node scripts/verify-github-config.mjs`

## Environment

- Use Node 24 or newer.
- Use pnpm workspaces; packages live under `packages/*`.
- The intended remote documented by the project is `git@github-personal:chily-john/stepkit.git`.

## Gotchas

- Generated output (`dist/`, `.turbo/`, coverage, package `node_modules/`, `.stepkit/runs/`) is not source of truth.
- New workflows should use the continuation model: `defineWorkflow({ ... start })`, `step(...)`, and `done(...)`; do not expand the older static `steps: []` compatibility path.
- Product docs may lag implemented v0 details. Use docs for direction/open questions, but treat living source and tests as authoritative when they conflict with implemented `core`/`sdk`/`cli` behavior.
- `testkit` exports and dashboard copy are temporary scaffolding, not public API/product direction.
- Branch protection cannot be fully enforced from repository files; GitHub settings must be configured separately.
- Dependency review currently has `continue-on-error: true` intentionally while the project is early.
- Touched-package CI is not implemented; assume all-package checks are the safe validation path.
