# @trailstep/provider-gemini

Official Gemini provider package for TrailStep.

## Install

```bash
npm install @trailstep/provider-gemini
trailstep providers add @trailstep/provider-gemini --scope project
trailstep agents set default --provider gemini --scope project
```

## Export

This package exports `trailstepProvider` from the package root.

## Hygiene flags

The exported manifest may declare a `hygiene` block that maps TrailStep execution fields (`tools`, `skills`, `mcp`, `extensions`, `contextFiles`) to real Gemini CLI argv flags:

```json
{
  "hygiene": {
    "tools": { "flag": "--allowed-tools" }
  }
}
```

`flag` is a value flag rendered as `flag value` (comma-separated allowlist). This package omits `skills`, `mcp`, `extensions`, and `contextFiles`: skills are managed per install with `gemini skills disable --all`, MCP control is allowlist-only (`--allowed-mcp-server-names` has no disable form), `--extensions` selects extensions instead of disabling them, and GEMINI.md discovery cannot be skipped per run. `--allowed-tools` is deprecated upstream in favor of the Policy Engine. An omitted capability renders nothing (graceful no-op); never declare a guessed flag. Back-compat rule: manifest loaders ignore unknown keys, so registration succeeds on every TrailStep version: capability keys the installed version does not read yet are skipped, never rejected.
