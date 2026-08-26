# Scopes and config

TrailStep uses scopes to decide where config, workflow registrations, package installs, and skills should live.

## Scope summary

| Scope | Use for | Typical command |
| --- | --- | --- |
| `local` | Private choices for this checkout/machine | `trailstep init --scope local` |
| `project` | Team-shared project config and workflows | `trailstep init --scope project` |
| `global` | User-wide defaults and personal workflows | `trailstep init --scope global` |

Rule of thumb: use project scope for repo setup, local scope for private overrides, and global scope for personal defaults that should follow you across projects.

## Config files

- Project config is stored under the current repo's `.trailstep/config.json`.
- Local config is stored under the current repo's `.trailstep/config-local.json`.
- Global config is stored under your home directory's `.trailstep/config.json`.

Project config can be committed when it represents shared team behavior. Local and generated runtime artifacts should remain private unless the project explicitly documents otherwise.

## Workflow registrations

Registered workflow refs include their namespace:

```bash
project/review
global/cleanup
local/scratch
```

You can list registrations with:

```bash
trailstep workflows
```

Project registrations are the default recommendation for workflows teammates should run the same way. Global registrations are useful for personal tools. Local registrations are useful for experiments and private overrides.

## Package-backed installs

When you add workflows from an npm package, TrailStep installs the package into a scope-aware root:

- `local` and `project` package installs use the current project root.
- `global` package installs use `~/.trailstep/packages`.

TrailStep detects the install root's package manager from lockfiles or `packageManager`; if neither exists, it defaults to `npm`.

## Agent config

Agent mappings control both workflow step dispatch and standalone managed agent sessions opened from the CLI. `trailstep` and `trailstep open` launch the first configured default target, `agents.default[0]`, in the current project. Named entries, such as `agents.reviewer[0]`, can be opened with `trailstep open reviewer`; bare `trailstep reviewer` opens the agent only when that token is not also a workflow ref. If a configured agent name matches a provider shortcut, the configured agent wins for open behavior. If a bare token also matches a workflow, TrailStep reports ambiguity and asks for explicit syntax.

Standalone open sessions use the first target in the selected agent entry for this MVP. They run in the current project through inherited stdio and write `.trailstep/sessions/<session-id>/` artifacts instead of workflow run artifacts.

Use the interactive editor for most changes:

```bash
trailstep agents
```

Or set a provider directly:

```bash
trailstep agents set default --provider pi --scope project
trailstep agents set reviewer --provider claude --thinking high --scope project
```

`--model` and `--thinking` are optional overrides. Omit either one to use the provider default. Use `trailstep init` when you need to create the initial `agents.default` entry, then `trailstep agents` or `trailstep agents set <name>` to add named mappings.

## Skill scope recommendations

Match skill target to registration scope when possible:

```bash
# Team-shared workflow registration plus project skill.
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes

# Personal global workflow registration plus user skill.
trailstep add @trailstep/create-flows@latest --scope global --workflow "*" --user-skill --yes
```

TrailStep warns about mismatches, such as project skills pointing at local registrations.
