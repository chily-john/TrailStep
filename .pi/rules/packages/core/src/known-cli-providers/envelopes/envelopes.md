---
kind: rules
paths:
  - packages/core/src/known-cli-providers/envelopes/
summary: Shared extraction of JSON output and usage metadata from provider CLI stdout envelopes.
triggers:
  - provider envelope
  - stdout parsing
  - agent_provider_output_invalid
  - usage metadata
---

# packages/core/src/known-cli-providers/envelopes/

Enter here when changing how provider stdout is converted into the single JSON object required by a working agent step.

## Rules

- Keep extraction provider-parameterized by result field; do not hardcode one vendor's envelope shape into generic parsing.
- Preserve plain-object-only output; arrays, primitives, and empty stdout should remain invalid for structured step output.
- If adding metadata extraction fields, keep missing provider fields optional and avoid requiring every provider to emit usage data.
