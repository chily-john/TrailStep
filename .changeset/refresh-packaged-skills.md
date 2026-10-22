---
"@trailstep/cli": patch
"@trailstep/authoring": patch
---

Refresh the packaged TrailStep usage and authoring skills with the latest verified CLI, runtime, retry, execution, and MCP behavior, and replace dead OpenViking context-store doc links in the shipped npm READMEs with repository links.

- The packaged `trailstep` usage skill now covers the run lifecycle (`continue`, `answer` with `--branch`/`--continue`, `retry`, `cancel` with `--clear`), automatic retries (`retry.maxAttempts` default 2, `retry.retryOn` default `"transient"`), execution settings (`settings.execution` global/per-workflow, field-by-field merge, `contextFiles` default `true`), and the current MCP server contracts (non-blocking `trst_run_workflow`, per-workflow tool exposure via `mcp.perWorkflowTools`, `trst_watch` runs-root handling, `trst_answer`/`trst_resume`).
- The packaged authoring skill now documents retry configuration and the durable parallel fan-out/join (`parallel(...)` + `.post(...)`, aggregate `{ status, branches }`, `failurePolicy`), and keeps the workflow-authored `skill` guidance aligned with the hard-removed generated-skills feature.
- Shipped npm READMEs no longer link to the canonical OpenViking context-store doc URIs (which are not resolvable from npm installs); they link to the corresponding repository files instead.

No changes to workflow authoring APIs or persisted event schemas.
