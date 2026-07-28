---
description: "Turns an already-organic conversation/feature request into a reviewed implementation plan, then implements it story by story."
---
Run the registered StepKit workflow `project/take-it-away`.

Create workflow input JSON at `.stepkit/inputs/project-take-it-away-input.json` that matches this normalized schema:

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

When this skill is invoked, run:

```bash
stepkit project/take-it-away --input-file .stepkit/inputs/project-take-it-away-input.json
```

Registered workflow source: `./packages/create-flows/src`
