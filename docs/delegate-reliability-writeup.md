# Delegate reliability: `max_tokens` mismatch + hang investigation (2026-10-19)

## TL;DR

Two distinct delegate failure modes shared one root cause area (model routing),
but were not the same bug:

1. **Fast failure** (`delegate-smart-implementor-20261019-184330-bd9f7a87`):
   `pi` requested `max_tokens ≈ 930k` (catalog `943.7K max-out`); OpenRouter's
   `GMICloud` backend caps completions at `131,072`. Instant `400`, zero work done,
   `agent_target_exhausted` after all targets failed.
2. **Slow grind** (`delegate-exec-context`, later cancelled): the model *was*
   working (29 tool calls) but cycled `work → 400 → prune → retry` for ~17 min,
   so TrailStep showed silence (`work.txt` only lands on `pi` exit).

Committed fix: fallback chains (`pro → flash → gemini-flash`) for
`smart-implementor/debugger/planner/expert` in `packages/sub-agents/package.json`
and `packages/create-flows/package.json` (commit `d60b323`, already landed via a
`take-it-away` run). Local override (`.trailstep/config-local.json`, gitignored)
is temporarily `flash`-first until OpenRouter routing stabilizes; committed
defaults stay `pro`-first for quality.

## Evidence

- Failing run: `.trailstep/runs/delegate-smart-implementor-20261019-184330-bd9f7a87/`
  - `steps/0003-delegate-turn/prompt.md`: 4,635 bytes (~1.1k tokens) — small.
  - `steps/0003-delegate-turn/output.json` + `work.txt` tail:
    `max_tokens is too large: 929852 / 930246 / 931612. Supports at most 131072.
    provider_name: GMICloud, previous_errors: [429 DeepInfra rate-limited]`.
  - `state.json`: `turns: 0`, `changedFiles: []` — nothing ran.
- Same string in `delegate-parallel-20261016-202520` (3 steps), `-205943`,
  `-20261017-184843` (2 steps), `-201522`, `-213305` — systemic since 10/16.
- Hung run session:
  `~/.pi/agent/sessions/--C--Users-cjohnson_xtivia-Desktop-TrailStep--/2026-10-19T19-26-48-396Z_b26da1b4-*.jsonl`
  — 65 lines / 377 KB, 29 `toolResult`s, 8× `400 max_tokens`, each followed by
  `context_edit` prune-and-retry, plus 30s/60s `bash` timeouts.
- `pi --list-models`: `mimo-v2.6-pro: 1.0M / 943.7K` vs
  `mimo-v2.6-flash / ultraspeed: 1.0M / 131.1K`, `gemini-2.5-flash: 1.0M / 65.5K`.
  The 131k backend cap matches the flash-tier catalog, not pro.
- History: `smart-implementor` pinned to `mimo-v2.6-pro` on 9/29 (`72d3f70`);
  before that it used the default (`muse-spark`). `pi@1.3.0` reinstalled 10/17.
  New model pin + mid-October OpenRouter backend/quota drift = first seen 10/16.

## Why input size was not the cause

Inferred input from `pi`'s math (`context − max_tokens`): ~68–103k tokens, ~7%
of the 1M window. TrailStep's prompt is 4.6 KB; `pi` auto-loads ~54 KB of skills,
~23 KB of openviking skills, ~21 KB trello ext, `AGENTS.md`, and tool schemas
(`provider-pi` emits no `--no-skills/--no-mcp/--tools` flags today). Normal for a
coding agent, well within the model. The failure is the *output* parameter, not
input limits — shrinking input would have grown the request further.

## Why the hang looked like a size mismatch but wasn't

The hung delegate fit its agent (`smart-implementor` for cross-file contract
work): correct files, no confusion, no capability errors. The 17 minutes went to
the 400→prune→retry loop plus slow tools. A smaller task on `mimo-pro` would
have hit the same wall. Proof: the same two tasks completed in 1 turn each on
`flash` (see below).

## What changed and what remains

- **Landed**: fallback chains (committed), MCP + provider `update-targets`
  scope (`1d20c85`, implemented directly after the original delegate failed).
- **Landed on disk, uncommitted**: lean `execution` context (16 files) +
  provider hygiene flags + docs (14 files) — the two `flash` delegates below.
- **Still open**: explicit `maxOutputTokens` cap (needs a `pi --max-tokens`
  flag first — `pi 1.3.0` has none, so TrailStep cannot cap today); per-turn
  wall-clock timeout + token/cost heartbeat (today `watch` is dark between
  `promptSent` and `outputReceived`); fail-over after N `max_tokens` 400s
  instead of pruning forever; CLI-startup orphan reaper (`cancel` itself works —
  verified no stray `pi` processes — but harness-killed CLIs can orphan).
