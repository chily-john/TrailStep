---
name: project-take-it-away
description: Turns an already-organic conversation/feature request into a reviewed implementation plan, then implements it story by story.
---

Run the registered TrailStep workflow `project/take-it-away` in an isolated git worktree.

Create workflow input JSON at `.trailstep/inputs/project-take-it-away-input.json` in the current checkout that matches this normalized schema:

```json
{
  "type": "object",
  "properties": {
    "conversation": {
      "type": "string"
    }
  },
  "required": [
    "conversation"
  ],
  "additionalProperties": false
}
```

If validation fails, fix the JSON file to match the schema before retrying.

When this skill is invoked, do not run `trailstep` directly in the current checkout. Run the isolation wrapper instead:

```bash
node scripts/run-trailstep-isolated.mjs project/take-it-away .trailstep/inputs/project-take-it-away-input.json --pr
```

The wrapper creates `.trailstep/worktrees/<run>/` on a new `trailstep/...` branch, copies the input file into that worktree, enables TrailStep's per-story commit mode, runs the workflow there, then pushes and opens a PR with `gh pr create --fill` when possible. If the user explicitly does not want a PR, use `--no-pr` instead of `--pr`.

Registered workflow source: `./packages/create-flows/src`
