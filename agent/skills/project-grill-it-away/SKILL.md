---
description: "Interactively grills the user until it understands the requested feature."
---
Run the registered TrailStep workflow `project/grill-it-away`.

Create workflow input JSON at `.trailstep/inputs/project-grill-it-away-input.json` that matches this normalized schema:

```json
{
  "type": "object",
  "properties": {},
  "required": [],
  "additionalProperties": false
}
```

If validation fails, fix the JSON file to match the schema before retrying.

When this skill is invoked, run:

```bash
trailstep project/grill-it-away --input-file .trailstep/inputs/project-grill-it-away-input.json
```

Registered workflow source: `./packages/create-flows/src#grillItAway`
