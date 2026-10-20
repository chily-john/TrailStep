# TrailStep test-infra handoff (2026-10-20)

This replaces the old two-round working-agent handoff (that work landed; the tree is green).
It records the testing infrastructure now in place and the test changes that still need to
happen next.

## Current state — green and verified

- `packages/testkit` → `packages/trailtest` (`@trailstep/trailtest`) rename complete; `testkitPackageMarker` kept as a deprecated alias.
- Two test lanes in `turbo.json`:
  - `test:fast` (16/16 green): everything except the slow e2e files. This is the agent loop.
  - `test:e2e` (8/8 green): `packages/cli/src/e2e-continuation.test.ts`,
    `packages/core/src/runtime/run-workflow/run-workflow-parallel-tracks.test.ts`,
    `packages/create-flows/src/take-it-away/workflow.test.ts` (and the grill-it-away full pipeline),
    `packages/mcp/test/run-workflow-tool.test.ts`.
- `trailtest` helpers v0.1 (`packages/trailtest/src`, 463 lines): `tmpProject`/`tmpGitRepo`,
  `fakeOutputFileHandler`, `expectEventSequence`, `runWorkflowWithStubs`, `stubSubWorkflow`.
  Proven by refactoring `packages/mcp/test/server-contract.test.ts` (-20 net lines).
- CI (`.github/workflows/ci.yml`): PRs run fast lane (lint + typecheck + test:fast + build);
  `test:e2e` runs on pushes to main. `release.yml` keeps the full suite.
- Local skill `agent/skills/trailtest/SKILL.md` documents lanes + helpers + safety rules.
- Root `@trailstep/*` cross-links pinned to `workspace:*` (enforced by
  `scripts/check-public-package-metadata.mjs`) so `pnpm-lock.yaml` never desyncs.

## Delegate runs: use the LOCAL CLI

The globally installed `trailstep` binary has a worker-spawn bug (unpublished fix). Launch
delegates with `node packages/cli/dist/index.js project/delegate...` (or `./trailstep-dev.sh`),
never the global binary. Zombie symptom: run dir has `prompt.md` but no `work.txt`, `turns=0`,
CLI wrapper process alive with no `pi` child.

## Tests that still need to change

### A. Adapter-mechanism removal (from the old handoff, still pending)

`packages/core/src/agent-execution/adapter-agent/` still exists even though production runs use
working mode two-phase (`run-manifest-working-provider.ts`). When removed:

- DELETE `packages/core/src/agent-execution/adapter-agent/` (incl. `run-adapter-agent-step.test.ts`, 739 lines).
- `packages/core/src/agent-execution/dispatch-agent-step/dispatch-agent-step.ts` — drop adapter routing (only `working` | `interactive`).
- `packages/core/src/authoring/step/agent-step.types.ts`, `continuation.types.ts`, `step-node.ts` — remove `adapter` from config/mode types.
- Test migrations: `packages/core/src/authoring/step/sub-prompt-concurrency.test.ts`,
  `sub-prompt-failures.test.ts`, `packages/authoring/src/prompts.test.ts` (6 adapter refs),
  `packages/core/src/runtime/run-workflow/run-workflow.test.ts` (2 adapter refs).
- Also grep-hit plumbing: `working-agent/prompts/build-provider-working-prompt.ts`,
  `run-working-agent-command.ts`, `run-working-agent-target-attempt.ts`,
  `interactive-agent/launch-interactive-agent-target.ts` (comment/type mentions).

### B. Adopt trailtest helpers (delete hand-rolled fakes)

Each refactor must be net-negative in lines. Candidates, biggest win first:

- `packages/create-flows/src/take-it-away/workflow.test.ts` (4783 lines) — hand-rolled `event()`
  factory, `git()` helper, `handleNonGreenStoryPhase` outputFile dispatcher →
  `expectEventSequence` + `tmpGitRepo` + `fakeOutputFileHandler`. Do NOT change the assertions'
  coverage; this is a pure fixture-migration and belongs in the e2e lane either way.
- `packages/sub-agents/src/delegate/workflow.test.ts` (640) — `initGitRepo`/`git()` → `tmpGitRepo`.
- `packages/mcp/test/trst-watch.test.ts` (212) — `TmpSandbox`/`createSandbox`/`eventLine` →
  `tmpProject` (+ v0.2 events.jsonl writer when it exists).
- `packages/mcp/test/trst-answer.tools.test.ts` (307) — `makeTempDir`/`writeWaitRun` →
  `tmpProject` (+ v0.2 wait-run fixture).
- `packages/cli/src/e2e-continuation.test.ts` — inline workflow/package fixture writers →
  shared fixture builder (only after a second consumer exists; otherwise leave).

### C. Forced by upcoming features (build the helper when the consumer lands)

- **Parallel stories**: `runWorkflowWithStubs` keys stubs by `stepId`, which collides across
  parallel tracks. Need (trackId/storyId, stepId) keying or a handler-function form.
  `run-workflow-parallel-tracks.test.ts` (2950 lines of `Deferred`/`delay`) is the pattern to
  shrink — classifier unit tests + one gated scheduler test + one isolation test only.
- **`new-feature` wrapper**: `stubSubWorkflow` only stubs happy `done(output)`. Need child
  failure propagation, child `wait`/answer, and child event streams for seam tests. Do NOT
  duplicate `take-it-away/workflow.test.ts` for the wrapper — stub the child.
- **MCP multi-run**: extract `connectedClient` from `server-contract.test.ts` into trailtest;
  add an events.jsonl writer + cursor assert for interleaved `trst_watch` / per-run `trst_answer`.

### D. Brittleness debt (opportunistic, not urgent)

Giant CLI command tests assert exact UX copy: `add-command.test.ts` (4195),
`update-command.test.ts` (2348), `agents-command.test.ts` (1359). Prefer behavior/contract
assertions over prompt-text snapshots when next touching these.

## Deferred

- Ephemeral `trailtest sandbox [--keep]` (agreed design: tmpdir + `--project` isolation,
  `init → add → run → doctor → mcp listTools` + verify + delete; no persistent `.sandbox/`).
- trailtest v0.2 helpers (see C) — extend on demand, proof-by-deletion gate for each.
