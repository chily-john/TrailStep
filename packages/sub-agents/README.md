# @trailstep/sub-agents

`@trailstep/sub-agents` is a public package of reusable TrailStep workflows for bounded delegated sub-agent work. The workflows share one durable delegate engine with run-local memory, typed outputs, optional parent/human questions, terminal summaries, and managed worktree support.

## Workflows

- `delegate`: default registered id `delegate`; flexible generic delegate with run-local continuity, optional parent/human questions, and typed results.
- `delegateExplore`: default registered id `delegateExplore`; read-oriented investigation with explore defaults.
- `delegateReview`: default registered id `delegateReview`; focused review with edit-avoidant guidance.
- `delegateImplement`: default registered id `delegateImplement`; bounded implementation with a larger turn budget.

The delegate workflows end with completed/blocked/cancelled status, summary/result text, changed files/artifacts, turn/question counts, optional worktree lifecycle details, and a terminal message readable with `trailstep output <runName> --message`.

## Recommended setup

Install the TrailStep CLI if you do not already have it, then use the interactive setup from your project root:

```bash
npm install --global @trailstep/cli
trailstep init
trailstep add @trailstep/sub-agents@latest
```

Choose **project** scope, select the workflows you want, and add project skills when prompted. Project skills let supported coding agents discover and run the workflows from the agent UI.

<details>
<summary>Scriptable setup</summary>

```bash
# Initialize config and install the packaged TrailStep usage skill.
trailstep init --scope project --install-skill

# Preview without installing, registering, or writing skills.
trailstep add @trailstep/sub-agents@latest --scope project --workflow "*" --project-skill --dry-run

# Install/register delegate workflows and generate project skills.
trailstep add @trailstep/sub-agents@latest --scope project --workflow "*" --project-skill --yes
```

</details>

Run registered workflows directly if you prefer the CLI:

```bash
trailstep project/delegate --task "Investigate failing parser tests" --mode explore
trailstep project/delegateExplore --task "Map the parser failure area"
trailstep project/delegateReview --task "Review the parser fix"
trailstep project/delegateImplement --task "Fix parser path normalization"
```

## Which delegate should I use?

Use the generic `delegate` when you want to choose `mode`, `maxTurns`, and context explicitly for explore, implement, review, or general work. Use `delegateExplore`, `delegateReview`, or `delegateImplement` when you want focused skill guidance and defaults while reusing the same delegate engine/steps.

```bash
trailstep project/delegate --task "Investigate failing parser tests" --mode explore
```

JSON input-file usage is useful for richer context:

```json
{
  "task": "Investigate failing parser tests",
  "context": "Parser fixtures fail only on Windows paths.",
  "mode": "explore",
  "cwd": "./packages/parser",
  "maxTurns": 6
}
```

```bash
trailstep project/delegate --input-file delegate-input.json
```

Parent-agent tips:

- For simple tasks, pass direct flags such as `--task`, `--mode`, `--cwd`, and `--maxTurns`.
- For long context, write JSON and use `--input-file` instead of stuffing the CLI command.
- Use unique run names for parallel delegates so run-local state does not collide.
- Use `cwd` for an existing worktree or subdirectory TrailStep should not manage. Use `worktree.enabled=true` to let the delegate create a managed git worktree.
- Managed worktrees default to `.trailstep/worktrees/<runName>`, branch `trailstep/delegate/<runName>`, and `cleanup="auto"`: clean completed worktrees are removed, while dirty/blocked/unsafe worktrees are kept and reported.
- The delegate can ask parent/human questions through TrailStep waits. Answer with `trailstep answer <runName> parent-answer --json '{"answer":"..."}'`, then resume with `trailstep continue <runName>`.
- Watch progress with `trailstep watch`, retry failed turns with `trailstep retry <workflowRef> <runName>`, read typed results with `trailstep output <runName>`, and read the final terminal summary with `trailstep output <runName> --message`.

## Delegate loop

```text
delegate-turn -> completed/blocked: done
delegate-turn -> continue: delegate-turn
delegate-turn -> question: ask-parent -> delegate-turn
```

The delegate keeps continuity only inside one TrailStep run; separate runs do not share memory. Memory is durable only in `.trailstep/runs/<runName>/state.json` for the active run.

## Managed worktrees

`cwd` and `worktree.enabled` are mutually exclusive execution-location strategies:

- `cwd`: run inside an existing directory/worktree; TrailStep does not manage lifecycle.
- `worktree.enabled=true`: create a managed git worktree from the project checkout, run delegate turns there, and report cleanup status.

Managed worktree input can include:

```json
{
  "worktree": {
    "enabled": true,
    "path": ".trailstep/worktrees/my-run",
    "baseRef": "main",
    "branch": "trailstep/delegate/my-run",
    "cleanup": "auto",
    "forceCleanup": false
  }
}
```

Cleanup behavior:

- `auto`: remove only clean completed worktrees; keep dirty, blocked, or unsafe worktrees.
- `never`: keep the worktree.
- `always`: remove clean worktrees; dirty worktrees require `forceCleanup=true`.

Default run-created branches are deleted after safe worktree removal. User-supplied branches are retained and reported.

## Direct package install

If you want to import the workflows from TypeScript or run bundle refs directly after installing them yourself, install the package and its peer dependency:

```bash
npm install @trailstep/sub-agents @trailstep/authoring
```

Then direct bundle refs use manifest names:

```bash
trailstep @trailstep/sub-agents#delegate --task "Investigate failing parser tests" --mode explore
trailstep @trailstep/sub-agents#delegateExplore --task "Map the parser failure area"
trailstep @trailstep/sub-agents#delegateReview --task "Review the parser fix"
trailstep @trailstep/sub-agents#delegateImplement --task "Fix parser path normalization"
```

Use the equivalent install command for your package manager if you use `pnpm`, `yarn`, or `bun`.
