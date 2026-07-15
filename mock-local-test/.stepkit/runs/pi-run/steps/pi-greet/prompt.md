# StepKit working-agent task

Respond with exactly one JSON object as your entire final answer.
Do not write output to a file. Do not include prose, markdown fences, or multiple JSON values in your final answer - only the JSON object itself.

The JSON object must match this output schema:

```json
{
  "type": "object",
  "properties": {
    "greeting": {
      "type": "string"
    }
  },
  "required": [
    "greeting"
  ],
  "additionalProperties": false
}
```

## Original prompt

Create a concise, friendly greeting for Ada. Write output as JSON with exactly this shape: {"greeting":"..."}.
