---
"@trailstep/cli": minor
"@trailstep/core": patch
---

Make global / project / local config scopes actually compose.

- Config scopes now deep-merge with a single `mergeConfigScopes` implementation. Previously only `agents` was deep-merged, so a project `settings.timeout` deleted a global `settings.retry`, and a local `workflows.<id>.agents.<role>` deleted every other role for that workflow in the project and global scopes. Arrays still replace wholesale; `undefined` never overrides; `null` deliberately clears.
- `trailstep agents <workflow>` now uses the same merge as the runtime. It previously used a third, deeper merge and would list roles the runtime would never see, which made configuration bugs very hard to diagnose. The output also gains a `Sources:` block naming which scope supplied each configured entry, and a new test asserts the display and `resolveAgentTargets` agree.
- One malformed config file no longer breaks every command. A global or project config that cannot be read or parsed is reported through `configErrors` (and on stderr by `run`, `continue` and `retry`) instead of throwing, so the remaining scopes still apply.
- The workflow registry is read through the same loader as the rest of the config, instead of a second, independently merged user-registry path. `workflowRegistry` is the canonical key; the legacy `workflows` string leaves that `trailstep add` still writes keep resolving for one release.
- New project-root discovery (`resolveProjectRoot`): `TRAILSTEP_PROJECT_ROOT` if set, else the invocation directory when it already has a `.trailstep` directory, else the nearest ancestor with `.git`, else the nearest ancestor with `package.json`, else the invocation directory. `run`, `continue` and `retry` resolve config, the workflow registry and run artifacts at that root while agents keep running in the invocation directory. Running a workflow from a nested directory previously created a second `.trailstep/` tree there and silently ignored the project's config and runs root. **If you have stray `.trailstep/` directories in subdirectories, delete or move them.**
