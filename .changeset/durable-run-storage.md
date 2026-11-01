---
"@trailstep/core": patch
---

Make the run event trail crash-tolerant and stop ignoring project config.

- `readRunEvents` now skips and reports malformed or non-event-shaped JSONL lines instead of throwing. A torn line from a crash mid-append previously made a run permanently unresumable, uncontinuable and unretriable; recovery now replays the rest of the trail. Accepts an optional `{ report }` callback.
- `appendEvent` serializes appends per `events.jsonl` in-process, so parallel branches, the agent heartbeat and the CLI cancel command can no longer interleave into a torn line.
- Removes the unused `persistEvents`, which rewrote the whole trail with a non-atomic `writeFile`.
- The generated `.trailstep/.gitignore` now lists run artifacts (`runs/`, `.archive/`, `sessions/`, `worktrees/`, `tmp/`, `inputs/`, `mcp/`, `config-local.json`, `run.lock`, `*.tmp`) instead of a blanket `*`. The previous body ignored `.trailstep/config.json`, so a fresh project silently failed to commit its shared config. A legacy generated file is repaired in place; a hand-edited one is never rewritten.
