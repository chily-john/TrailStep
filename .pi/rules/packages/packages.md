---
kind: rules
paths:
  - packages/
summary: Workspace package map and when to enter each TrailStep package.
triggers:
  - package boundary
  - workspace package
  - core package
  - authoring package
  - CLI package
  - testkit package
  - dashboard package
  - create-flows package
---

# packages/

Enter here when deciding which workspace package should own a change. Package boundaries are intentionally publishable and role-based.

## Subdirectories

- `core/`: Enter for framework-neutral contracts, authoring primitives, continuation execution, shapes, failures, events, run artifacts, config-driven agent targeting, command/adapter agent execution, interactive handoff, and the built-in known-CLI provider registry.
- `authoring/`: Enter for TypeScript authoring ergonomics layered over core: `defineWorkflow`, fluent `step` factories, `done`, `fail`, `promptTemplate`, shape re-exports, and author-facing workflow metadata.
- `cli/`: Enter for the `trailstep` binary, workflow package discovery/installation, skill checks, doctor/update command UX, interactive continuation, JSON input loading, agent/config initialization/editing UX, `.trailstep/config.json` loading, retry handling, and local workflow execution UX.
- `dashboard/`: Enter for Svelte/Vite local workflow run observability surfaces backed by read-only `.trailstep/runs` APIs.
- `testkit/`: Enter for reusable workflow testing utilities and package-level testing helpers.
- `create-flows/`: Enter for TrailStep workflow definitions, implementation-doc story splitting with `<!-- trailstep-story-boundary -->`, package workflow manifest wiring, copied shared prompt assets, and build verification for non-TS prompt fragments; currently exposes `takeItAway` and `grillItAway`.

## Rules

- If the package set changes, update workspace config, repository documentation, package verification, and CI/release assumptions together.
- Keep package READMEs publish-oriented and short; source/tests own implementation detail.
- Treat package `dist/`, `.turbo/`, and package-local `node_modules/` as generated output.
