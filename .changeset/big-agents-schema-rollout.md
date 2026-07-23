---
"@stepkit/core": major
"@stepkit/cli": major
---

Replace the legacy agent configuration shape with the unified `customProviders` and `agents.*` schema, where each agent entry is a plain fallback-chain array instead of an `{ items: [...] }` wrapper object. CLI docs now cover `stepkit init` and `stepkit agents` for configuring providers, reusable agent entries, and workflow role mappings.
