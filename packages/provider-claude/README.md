# @trailstep/provider-claude

Official Claude provider package for TrailStep.

## Install

```bash
npm install @trailstep/provider-claude
trailstep providers add @trailstep/provider-claude --scope project
trailstep agents set default --provider claude --scope project
```

## Export

This package exports `trailstepProvider` from the package root.

## Hygiene flags

The exported manifest may declare a `hygiene` block that maps TrailStep execution fields (`tools`, `skills`, `mcp`, `extensions`, `contextFiles`) to real Claude Code CLI argv flags:

```json
{
  "hygiene": {
    "tools": { "flag": "--tools" },
    "skills": { "disableFlag": "--disable-slash-commands" },
    "mcp": { "disableFlag": "--strict-mcp-config" }
  }
}
```

`flag` is a value flag rendered as `flag value`; `disableFlag` renders when the execution block suppresses that capability. Flags are split on whitespace into separate argv entries (`-c key=value` renders as `-c`, `key=value`); prefer the single-token `--flag=value` form for values. This package omits `extensions` and `contextFiles`: Claude Code has no dedicated per-session suppression flag for plugins or CLAUDE.md discovery (`--safe-mode` and `--bare` disable far more than context files). An omitted capability renders nothing (graceful no-op); never declare a guessed flag. Back-compat rule: manifest loaders ignore unknown keys, so registration succeeds on every TrailStep version: capability keys the installed version does not read yet are skipped, never rejected.
