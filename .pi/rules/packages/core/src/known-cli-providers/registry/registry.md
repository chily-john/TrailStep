---
kind: rules
paths:
  - packages/core/src/known-cli-providers/registry/
summary: Built-in provider registry keys and provider adapter contracts.
triggers:
  - provider registry
  - ProviderAdapter
  - provider key
  - built-in provider
---

# packages/core/src/known-cli-providers/registry/

Enter here when changing the public set of built-in provider ids or the adapter interface implemented by provider modules. The registry is consulted before `customAgents`, so provider-key changes affect local config resolution.

## Rules

- Keep registry keys stable unless config migration is part of the same change.
- Provider adapters expose working and interactive methods only; generic retry/fallback and file-protocol behavior belongs outside the registry.
- Provider working requests receive prepared file paths, optional model/thinking values, and abort signals; interactive requests may receive environment variables and abort signals; providers decide whether stdout parsing or vendor file output is appropriate.
