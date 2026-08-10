---
name: project-grill-it-away
description: Interactively grills the user until it understands the requested feature.
---

Run the registered TrailStep workflow `project/grill-it-away` in an isolated git worktree.

Create workflow input JSON at `.trailstep/inputs/project-grill-it-away-input.json` in the current checkout that matches this normalized schema:

```json
{
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false
}
```

For this workflow, the file should normally contain:

```json
{}
```

If validation fails, fix the JSON file to match the schema before retrying.

When this skill is invoked, do not run `trailstep` directly in the current checkout. Run the isolation wrapper instead:

```bash
node scripts/run-trailstep-isolated.mjs project/grill-it-away .trailstep/inputs/project-grill-it-away-input.json --pr
```

The wrapper creates `.trailstep/worktrees/<run>/` on a new `trailstep/...` branch, copies the input file into that worktree, enables TrailStep's per-story commit mode, runs the workflow there, then pushes and opens a PR with `gh pr create --fill` when possible. If the user explicitly does not want a PR, use `--no-pr` instead of `--pr`.

Registered workflow source: `./packages/create-flows/src#grillItAway`
