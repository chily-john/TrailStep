---
"@trailstep/cli": minor
---

Make config writes crash-safe and align scope defaults.

- Scope config files are now written atomically through `atomicWriteJson`, and a new `updateRawTrailStepConfigFile` gives every read-modify-write caller one safe path. Two concurrent `trailstep add` / `trailstep agents set` invocations previously lost one update, and a crash mid-write left truncated JSON.
- `appendGitignoreEntry` only treats `ENOENT` as "file is empty". Any other read failure (`EACCES`, `EISDIR`, `EBUSY`, `EPERM`) now throws instead of silently overwriting the user's entire `.gitignore` with a single entry. The append itself is atomic.
- The duplicated agent/role writers in `add` and `agents` are collapsed into one implementation, so the two commands can no longer drift.
- `trailstep agents rename` no longer half-applies: references are renamed before the config is rewritten, so a failure leaves the agent addressable under its old name.
- **Behaviour change:** `trailstep add --yes` without `--scope` now registers in the **local** (gitignored) scope. It previously registered in `project`, which meant an automated or agent-driven invocation silently committed to the team's shared config while an interactive run did not. Pass `--scope project` to share.
- `trailstep agents explain` no longer requires `--scope`, since it reports the merged effective config across all scopes.
- The named-agent picker only offers reserved size names (`tiny`, `small`, `medium`, `large`, `xl`) that some scope actually configures, instead of leading users into "does not exist in any config scope".
