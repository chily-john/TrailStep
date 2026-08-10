---
kind: rules
paths:
  - packages/core/
summary: `@trailstep/core` package for framework-neutral TrailStep contracts, authoring primitives, runtime, config-driven agent execution, and provider CLI registry.
triggers:
  - '@trailstep/core'
  - core package
  - runtime
  - event primitives
  - workflow model
  - provider registry
---

# packages/core/

Enter here for changes that should be independent of authoring ergonomics, CLI UX, testing helpers, or dashboard UI. `core` owns framework-neutral contracts and runtime implementation.

## Areas

- `src/`: Enter when adding or changing exported contracts, authoring primitives, runtime behavior, known-CLI providers, config parsing, targeting, or tests.
- `package.json`: Enter when package metadata, exports, dependencies, build scripts, or publish files for `@trailstep/core` change.
- `README.md`: Enter when publish-facing runtime behavior changes.

## Rules

- Keep this package framework-neutral and free of CLI UX, Svelte, and in-process vendor SDK dependencies.
- Built-in providers are core-owned known-CLI invocations for `claude`, `codex`, `pi`, and `gemini`; anything else goes through `customProviders`.
- Runtime retry policy and retry replay are core-owned; CLI UX should call the runtime retry entrypoint instead of duplicating replay.
- New runtime work should target fluent callable continuation workflows; do not revive positional step APIs or static `steps: []` as the main path.
