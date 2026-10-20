# @trailstep/provider-pi

Official Pi provider package for TrailStep.

## Install

```bash
npm install @trailstep/provider-pi
trailstep providers add @trailstep/provider-pi --scope project
trailstep agents set default --provider pi --scope project
```

## Export

This package exports `trailstepProvider` from the package root.

## Hygiene flags

The exported manifest may declare a `hygiene` block that maps TrailStep execution fields (`tools`, `skills`, `mcp`, `extensions`, `contextFiles`) to real Pi CLI argv flags:

```json
{
  "hygiene": {
    "tools": { "flag": "--tools" },
    "skills": { "flag": "--skill", "disableFlag": "--no-skills" },
    "mcp": { "disableFlag": "--no-mcp" },
    "extensions": { "disableFlag": "--no-extensions" },
    "contextFiles": { "disableFlag": "--no-context-files" }
  }
}
```

`flag` is a value flag (`--tools <allowlist>`, `--skill <path>`); `disableFlag` renders when the execution block suppresses that capability. Flags are split on whitespace into separate argv entries (`-c key=value` renders as `-c`, `key=value`); prefer the single-token `--flag=value` form for values. Omit a capability the CLI does not support per run — an omitted capability renders nothing (graceful no-op); never declare a guessed flag. Back-compat rule: manifest loaders ignore unknown keys, so registration succeeds on every TrailStep version: capability keys the installed version does not read yet are skipped, never rejected.
