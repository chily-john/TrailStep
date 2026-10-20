# @trailstep/provider-codex

Official Codex provider package for TrailStep.

## Install

```bash
npm install @trailstep/provider-codex
trailstep providers add @trailstep/provider-codex --scope project
trailstep agents set default --provider codex --scope project
```

## Export

This package exports `trailstepProvider` from the package root.

## Hygiene flags

The exported manifest may declare a `hygiene` block that maps TrailStep execution fields (`tools`, `skills`, `mcp`, `extensions`, `contextFiles`) to real Codex CLI argv flags:

```json
{
  "hygiene": {
    "mcp": { "disableFlag": "--config=mcp_servers={}" },
    "extensions": { "disableFlag": "--disable=plugins" }
  }
}
```

`disableFlag` renders when the execution block suppresses that capability. Flags are split on whitespace into separate argv entries (`-c key=value` renders as `-c`, `key=value`); prefer the single-token `--flag=value` form for values. This package omits `tools`, `skills`, and `contextFiles`: `codex exec` has no per-tool allow/deny flag, no runtime skills flag, and no flag to skip the AGENTS.md project doc (`--ignore-user-config` and `--ignore-rules` cover only user config and execpolicy rules). An omitted capability renders nothing (graceful no-op); never declare a guessed flag. Back-compat rule: manifest loaders ignore unknown keys, so registration succeeds on every TrailStep version: capability keys the installed version does not read yet are skipped, never rejected.
