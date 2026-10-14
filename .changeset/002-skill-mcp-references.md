---
"002-skill-mcp-references": minor
---

Update `.trailstep/skills/trailstep.md` and `.trailstep/skills/trailstep-authoring.md` with concise MCP references (`trailstep mcp`, lazy-load engine init, `run_workflow` non-blocking `{runId,status}`, `trst_watch` / `trst_answer` / `trst_resume`, `.trailstep/mcp/instructions.md` resource, absolute `--project` via `path.resolve()`, load-order precedence local > project > global). Preserve existing `defineWorkflow` documentation in authoring skill; do not expand `shape` syntax or add manifest-file references.

Pipeline / build hygiene verified: `.trailstep/.gitignore` and root `.gitignore` (`.trailstep/*` plus explicit `.trailstep/skills/`) exclude generated skill artifacts from emitted `dist/` / `.trailstep/runs/`; no pollution detected. No manifest file introduced. Story 001 artifacts (`.trailstep/mcp/trst_*.json`, `ordered-serialize`, `load-order` dirs, `validate-structural`) untouched.
