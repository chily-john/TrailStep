# Agent guide

TrailStep is a durable, typed, observable workflow harness for coding agents. It is a TypeScript-first pnpm monorepo and a clean-slate project separate from Workflower. Workflows are authored in TypeScript, discovered from packages, run through a continuation runtime, and observed through persisted local run artifacts.

This root context file contains a map of the codebase. Path-scoped context files under `.pi/rules/` hold institutional knowledge — invariants, gotchas, and conventions that can't be derived by reading the code. A generated knowledge graph at `graphify-out/` (when present) covers structural questions instead — where something lives, what calls what, cross-file relationships.

- For "where is X" / "what depends on Y" / architecture questions: if `graphify-out/graph.json` exists, run `graphify query "<question>"` before grepping raw files (see `CLAUDE.md`). If it doesn't exist (fresh clone, CI), fall back to normal search.
- For "why is it built this way" / conventions / known pitfalls: use injected `.pi/rules` context as the first source. Trust injected rules as current during normal implementation; if they do not answer where or how to proceed, inspect `.pi/rules` directly.
- Read source files to verify local style, existing APIs, or implementation details in both cases.

## Project Structure

```text
├── packages/             # Publishable workspace packages
│   ├── core/             # Framework-neutral runtime, shapes, continuation engine, events, agent targeting, provider CLI registry
│   ├── authoring/        # TypeScript authoring helpers layered over core primitives
│   ├── cli/              # `trailstep` workflow discovery, skill checks, config loading, and local execution command
│   ├── testkit/          # Workflow testing utilities package surface
│   └── dashboard/        # Svelte/Vite local workflow run observability UI
├── scripts/              # Local release-readiness and artifact hygiene checks
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
- Public package metadata readiness: `pnpm check:public-packages`
- Local artifact ignore readiness: `node scripts/check-local-artifact-ignore.mjs`
- Verify stale verification-script cleanup: `pnpm check:verification-cleanup`

## Environment

- Use Node 24 or newer.
- Use pnpm workspaces; packages live under `packages/*`.
- The intended remote documented by the project is `git@github-personal:chily-john/trailstep.git`.

## Gotchas

- Generated output (`dist/`, `.turbo/`, coverage, package `node_modules/`, `.trailstep/runs/`) is not source of truth.
- New workflows should use the continuation model: `defineWorkflow({ ... start })`, `step(...)`, and `done(...)`; do not expand the older static `steps: []` path.
- Living source and tests are authoritative when package README text or rules drift.
- Branch protection cannot be fully enforced from repository files; GitHub settings must be configured separately.
- Dependency review currently has `continue-on-error: true` intentionally while the project is early.
- Touched-package CI is not implemented; assume all-package checks are the safe validation path.
