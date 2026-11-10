---
"@trailstep/core": patch
"@trailstep/cli": patch
"@trailstep/mcp": patch
---

Patch published runtime transitive security fixes.

- Pin `fast-uri` to 3.1.9 via `ajv`: `@trailstep/core` depends on `ajv` directly, and `@trailstep/cli` / `@trailstep/mcp` pull the same `ajv` path transitively through `@modelcontextprotocol/sdk`.
- Pin `body-parser` to 2.4.0 via `express`: `@trailstep/cli` / `@trailstep/mcp` pull it transitively through the MCP SDK `express` dependency.

`deepmerge` 4.3.1 advisory remains visible with no patched release available; this changeset does not claim all vulnerabilities are gone. `vitest` and dashboard `vite`/svelte-plugin bumps are dev/build-only and do not trigger separate published bumps.
