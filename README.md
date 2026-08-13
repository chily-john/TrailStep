# TrailStep

TrailStep is a durable, typed, observable workflow harness for coding agents.

## Packages

Initial public packages:

- `@trailstep/core` — framework-neutral runtime primitives. Install with `pnpm add @trailstep/core`.
- `@trailstep/authoring` — TypeScript workflow authoring helpers. Install with `pnpm add @trailstep/authoring`.
- `@trailstep/cli` — the `trailstep` command. Install with `pnpm add -D @trailstep/cli`.
- `@trailstep/create-flows` — reusable workflow automation. Install with `pnpm add @trailstep/create-flows`.

Workspace packages not published in the initial public set:

- `@trailstep/testkit` is not part of the initial public publish set.
- `@trailstep/dashboard` is not part of the initial public publish set.

## CLI

Run `trailstep init [--scope <local|project|global>] [--install-skill | --no-install-skill]` to create configuration. Use `--install-skill` to install the packaged usage skill, or `--no-install-skill` to skip it. There is no npm postinstall prompt.

Workflows use JSON object inputs. Reference forms:

- Direct refs: `trailstep ./workflows/review.ts#review --input-file input.json`
- Registered refs: `trailstep project/review`
- Bundle refs: `trailstep @acme/workflows#review`

Use `trailstep continue` to complete interactive steps and `trailstep retry` to retry failed runs.

### Workflow package lifecycle

`trailstep add` can register direct local refs or package-backed workflows from versioned npm package specs (for example, `@acme/workflows@latest`) and explicit `github:<owner>/<repo>` specs. Package-backed adds install into the selected scope root, discover workflows, and store package metadata with each registration. Use `--dry-run` on package-backed adds to inspect the plan without installing, registering, or writing skills.

Scope controls where packages live: local/project installs use the current project root, while global installs use `~/.trailstep/packages`. `trailstep remove` deletes the registration and only uninstalls orphaned TrailStep-owned package installs; user-owned installs, still-referenced packages, and missing or stale metadata are preserved. If cleanup fails, the registration remains removed and the command reports the package root for manual cleanup.

Use `trailstep update --workflows` to update registered npm-backed workflow packages, `trailstep update --workflow <name>` for one workflow package target, or `trailstep update --all` to combine TrailStep package updates with workflow package updates across project/global roots. Updates prompt before writing unless `--yes` or `--assume-yes` is passed. Local-file refs are not package update targets, missing/stale metadata is skipped or rejected before mutation, and GitHub-sourced workflow package updates are not supported yet.

## Authoring model

Author workflows with `defineWorkflow({ start })`, compose continuation steps with `step(...)`, and finish with `done(...)`. Workflow metadata may define workflow-level `agents`, and each step may define a step-level `agent` role.

## Artifacts and validation

Run artifacts live under `.trailstep/runs` and should not be manually mutated. Local runtime and agent artifacts are ignored by default.

Useful checks:

- `pnpm check:public-packages`
- `pnpm run pack:public:dry-run`
- `node scripts/check-local-artifact-ignore.mjs`
