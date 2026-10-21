# Agent guide

TrailStep is a durable, typed, observable workflow harness for coding agents. It is a TypeScript-first pnpm monorepo and a clean-slate project separate from Workflower. Workflows are authored in TypeScript, discovered from packages, run through a continuation runtime, and observed through persisted local run artifacts.

This root context file contains a map of the codebase. **OpenViking is the canonical documentation and code index for this project**: the full documentation tree lives at `viking://resources/trailstep/docs/` inside the repo index `viking://resources/trailstep/` (setup guide: the committed `docs/openviking-setup.md`). In-repo docs under `docs/` are pointers only — see `docs/README.md`. Prefer `openviking_search` / `openviking_find` for discovery and `openviking_read` / `openviking_tree` / `openviking_grep` / `openviking_glob` for traversal. Do not fall back to `rg` / `ls` / direct file reads unless the OpenViking tools are unavailable.

- For "where is X" / "what depends on Y" / architecture questions: use OpenViking `search` / `find` first, then `tree` / `grep` / `glob` to map structure.
- For "why is it built this way" / conventions / known pitfalls: living source and tests are authoritative; read the canonical docs via OpenViking (`viking://resources/trailstep/docs/`) and check nearby package README sections.
- Use OpenViking `read` / `tree` to verify local style, existing APIs, or implementation details in both cases.
- Do not author new documentation in the repo — write it into the OpenViking doc store (`viking://resources/trailstep/docs/`). The only in-repo docs are `docs/README.md` (pointer) and `docs/openviking-setup.md` (committed setup guide). Package-level READMEs (`packages/*/README.md`) stay in the repo because they ship to npm; they are not documentation duplication.
- **Never sync the in-repo `./docs` directory into `viking://resources/trailstep/docs`.** OpenViking's sync-to-existing deletes entries missing from the source, and the in-repo `docs/` folder only holds pointers, so such an import WIPES the canonical documentation. Refresh the index with `scripts/refresh-openviking-index.sh` (code trees only) and restore wiped docs with `scripts/refresh-openviking-index.sh --restore-docs` (reads `git show HEAD:docs/<file>` and re-imports). Repo-root imports must keep `.claude`, `.agents` and `.pi` in `--ignore-dirs` or they fail with an `IO Error` on those symlinks.

## Project Structure

```text
├── packages/             # Publishable workspace packages
│   ├── core/             # Framework-neutral runtime, shapes, continuation engine, events, agent targeting, provider CLI registry
│   ├── authoring/        # TypeScript authoring helpers layered over core primitives
│   ├── cli/              # `trailstep` workflow discovery, skill checks, config loading, and local execution command
│   ├── mcp/              # TrailStep MCP server (`trst_*` tools over real CLI seams; generated `.trailstep/mcp` tool JSONs)
│   ├── sub-agents/       # Reusable delegate/sub-agent workflows
│   ├── trailtest/        # Workflow testing utilities package surface (`@trailstep/trailtest`)
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
- Test fast: `pnpm exec turbo run test:fast` (per-package: `pnpm --filter <pkg> test:fast`)
- Test e2e: `pnpm exec turbo run test:e2e` (only for add/MCP/parallel composition)
- Build: `pnpm build`
- Format: `pnpm format`
- Public package metadata readiness: `pnpm check:public-packages`
- Public package tarball readiness: `pnpm run pack:public:dry-run`
- Local artifact ignore readiness: `node scripts/check-local-artifact-ignore.mjs`
- Sandbox: `pnpm sandbox [--keep]` (ephemeral full-project repro)

## Environment

- Use Node 24 or newer.
- Use pnpm workspaces; packages live under `packages/*`.
- The intended remote documented by the project is `git@github-personal:chily-john/trailstep.git`.

## Gotchas

- Generated output (`dist/`, `.turbo/`, coverage, package `node_modules/`, `.trailstep/runs/`) is not source of truth.
- Search with `rg` (it respects `.gitignore`); never run `grep -r` / `find` from the repository root — that walks ~150k files in `node_modules/`, `data/` and `.trailstep/`, while `rg` sees ~579 in under a second. Scope searches to `packages/<pkg>/src`.
- The OpenViking vector store lives in `data/vectordb/context` and is rebuildable; the sibling `data/viking` tree is **not** — it holds the canonical documentation, which exists only in OpenViking at `viking://resources/trailstep/docs/`. Never delete `data/viking`. Changing the embedding model or dimension means deleting `data/vectordb/context` and re-running the reindex (see `docs/openviking-setup.md`).
- Internal `@trailstep/*` cross-links must use `workspace:*` (enforced by `pnpm check:public-packages`); never pin them to `^x.y.z` in `package.json`, or version bumps will desync `pnpm-lock.yaml` and fail CI `pnpm install --frozen-lockfile` with `ERR_PNPM_OUTDATED_LOCKFILE`.
- After editing any `package.json`, run `pnpm install` and commit the updated `pnpm-lock.yaml` — but only regenerate the lockfile on a CLEAN tree (uncommitted manifest edits get baked into it and fail CI `--frozen-lockfile` with `ERR_PNPM_OUTDATED_LOCKFILE`). Verify with `node scripts/check-lockfile-sync.mjs` before pushing.
- New workflows should use the continuation model: `defineWorkflow({ ... start })`, `step(...)`, and `done(...)`; do not expand the older static `steps: []` path.
- Living source and tests are authoritative when package README text or rules drift.
- Branch protection cannot be fully enforced from repository files; GitHub settings must be configured separately.
- Dependency review currently has `continue-on-error: true` intentionally while the project is early.
- Touched-package CI is not implemented; assume all-package checks are the safe validation path.
