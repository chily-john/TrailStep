# TrailStep Two-Round Working Agent Implementation - Handoff Document

## Problem Statement

The `take-it-away` workflow was stalling at agent steps because the adapter mechanism (multi-round prompting) wasn't being used by production workflows. Production workflows use **working mode** (`runWorkingAgentCommand` → `runManifestWorkingProvider`), which is a **single-shot subprocess** mechanism, while the adapter fix (`f0ced95`) only applied to **adapter mode** (persistent session with multi-round prompting).

**Key Issue**: Working agent runs once, writes `output.json`, exits. No multi-round prompting, no session persistence.

## What Has Been Implemented

### 1. Provider Manifest Update (`.trailstep/config.json`)
- Added `followUp` support to `pi` provider manifest
- `followUp.supported: true`
- `followUp.resumeArgs: ["--resume", "{{sessionId}}"]`
- `followUp.sessionIdFlag: "--session-id"`

### 2. Two-Phase Working Agent Execution (Always On)
**File**: `packages/core/src/agent-execution/working-agent/targets/manifest-provider/run-manifest-working-provider.ts`

**Changes**:
- **Always uses two phases** (removed single-phase path)
- **Phase 1 (Work)**: Work-only prompt → agent does work → writes raw report to `workFile`
- **Phase 2 (Output)**: Schema-derived output prompt → agent formats to strict schema → writes `output.json`
- **Session Persistence**: Both phases use same session via `followUp.resumeArgs` + `sessionIdFlag`
- **Schema-derived Output Prompt**: Ported `buildOutputPrompt()` from adapter fix
- **Single Step Timeout**: Applies to both phases combined (Phase 1 gets most, Phase 2 gets remainder)

### 3. Observability Events
Added 6 new event types to `Event` type (`run-workflow.types.ts` + `run-context.types.ts`):
| Event | When Emitted |
|-------|--------------|
| `agent.spawned` | Provider process started (phase: work/output) |
| `agent.promptSent` | Prompt file written, process spawned |
| `agent.outputRequested` | Phase 2 (output) started |
| `agent.outputReceived` | Output file read successfully (both phases) |
| `agent.sessionResumed` | Phase 2 resumes same session |
| `agent.targetSelected` | Before each target attempt |

Emitted in:
- `runManifestWorkingProvider.ts` (both phases)
- `runCustomWorkingProvider.ts` (single phase)
- `runWorkingAgentCommand.ts` (target selection)

### 4. Timeout Handling
- **No default timeout** - user must configure `step.timeout`
- Single timeout applies to **entire step** (both phases)
- Phase 1 gets `timeoutMs - 5000ms`, Phase 2 gets remainder
- Timeout error code: `agent_step_timeout` (new) / `agent_provider_timeout` (per-phase)
- Defensive file-read still attempted on timeout

### 5. Test Updates
**Updated test files**:
- `run-manifest-working-provider.test.ts` - Complete rewrite for two-phase always
- `run-working-agent-command.test.ts` - Added followUp config, expect 2 phases
- `run-sub-prompt.ts` - Pass `emit` + `runId` to working agent command

## What Still Needs To Be Done

### 1. Fix Failing Tests (15 failures)
| Test File | Failures | Issue |
|-----------|----------|-------|
| `run-adapter-agent-step.test.ts` | 8 | Adapter tests still expect old behavior |
| `run-working-agent-command.test.ts` | 5 | Some tests need two-phase expectations |
| `run-workflow-timeout.test.ts` | 1 | Timeout test expects old behavior |
| `workflow-cancellation.test.ts` | 1 | Cancellation test needs update |

### 2. Remove Adapter Mechanism (Per Requirements)
**Files to DELETE**:
- `packages/core/src/agent-execution/adapter-agent/` (entire directory)

**Files to MODIFY**:
- `dispatch-agent-step.ts` - Remove adapter routing, only `working` | `interactive` modes
- `agent-step.types.ts` - Remove `adapter` from config, `mode = "working" | "interactive"`, default `"working"`
- `agent-adapter.types.ts` - Remove `AgentAdapter`, `AgentAdapterObject`, `AgentAdapterSelection`
- `packages/authoring/src/index.ts` - Remove `adapter` from `PromptOptions`, `defineWorkflow` skill deprecation

**Tests to UPDATE/DELETE**:
- `run-continuation.test.ts` - Remove adapter expectations
- `run-workflow.test.ts` - Same
- `sub-prompt*.test.ts` - Migrate to working agent
- `packages/authoring/src/prompts.test.ts` - Replace adapter objects

### 3. Verify pi CLI Supports Session Flags
Need to confirm `pi` CLI actually supports:
- `--session-id <id>` for Phase 1
- `--resume <sessionId>` for Phase 2

If not, need to add to `packages/provider-pi/`

### 4. Run Full Test Suite
```bash
pnpm test
pnpm typecheck
pnpm build
```

All must pass before merge.

## Current Test Status (as of last run)

```
Test Files: 56 passed, 5 failed (61 total)
Tests: 384 passed, 15 failed (399 total)
```

### Failing Test Categories:
1. **Adapter tests** (8) - Expect old adapter behavior with `submit_output` tool
2. **Working agent command tests** (5) - Some still expect single-phase
3. **Timeout test** (1) - Expects old timeout behavior
4. **Cancellation test** (1) - Needs update for two-phase

## Architecture Decisions Made

| Decision | Rationale |
|----------|-----------|
| Two-phase ALWAYS on | Simpler than conditional; matches adapter's explicit two-round design |
| Schema-derived output prompt | Consistent with adapter; guides agent to produce valid output |
| Single step timeout | User controls total time; no per-phase complexity |
| New event types (not overloading step.progress) | Clear observability; debuggable session lifecycle |
| Session resume via followUp | Leverages existing manifest mechanism; no new provider interface |

## Key Files Modified

```
packages/core/src/
├── agent-execution/
│   ├── dispatch-agent-step/dispatch-agent-step.ts          # Pass emit/runId
│   ├── working-agent/
│   │   ├── run-working-agent-command.ts                    # Add emit/runId, targetSelected event
│   │   ├── targets/
│   │   │   ├── manifest-provider/run-manifest-working-provider.ts  # MAJOR REWRITE
│   │   │   ├── custom-provider/run-custom-working-provider.ts      # Add events
│   │   │   └── run-working-agent-target-attempt.ts               # Pass through emit/runId
│   │   └── prompts/build-two-phase-prompts.ts              # (existing)
├── runtime/
│   ├── run-workflow/run-workflow.types.ts                  # Added 6 new event types
│   ├── sub-prompts/run-sub-prompt.ts                       # Pass emit/runId
│   └── events/create-run-event.ts                          # (unchanged)
├── contracts/run-context/run-context.types.ts              # Added 6 new event types
└── providers/provider-manifest.ts                          # (types updated for followUp)

.trailstep/config.json                                      # pi provider followUp config
```

## Next Steps for Completion

1. **Fix remaining 15 test failures** - Update expectations for two-phase behavior
2. **Delete adapter mechanism** - Remove all adapter-agent code and routing
3. **Update all test files** - Migrate from adapter to working agent
4. **Verify pi CLI session support** - Add `--session-id`/`--resume` if missing
5. **Run full validation** - `pnpm test && pnpm typecheck && pnpm build`
6. **Test end-to-end** - Run `take-it-away` workflow to verify fix

## Notes

- The adapter fix (`f0ced95`) is **committed and pushed** but only affects adapter mode
- This implementation ports the two-round logic to working mode where production runs actually execute
- The `.trailstep/config.json` change is local; may need to be propagated to CI/shared configs
- All changes are in `packages/core` - no changes to `packages/cli`, `packages/create-flows`, etc. needed