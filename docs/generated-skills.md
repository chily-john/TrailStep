# Generated skills

Generated skills make registered TrailStep workflows agent-native.

A registered workflow gives TrailStep a stable ref such as `project/review`. A generated skill gives a coding agent instructions for when and how to call that ref. In agents that expose skills as slash commands, this lets users invoke workflows from the agent UI instead of manually typing CLI commands.

## Generate a skill while adding a workflow

Project skill for a team-shared workflow:

```bash
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --project-skill --yes
```

User skill for a personal workflow:

```bash
trailstep add @trailstep/create-flows@latest --scope global --workflow "*" --user-skill --yes
```

Local file workflow with a project skill:

```bash
trailstep add ./workflows/review.ts#review --scope project --name review --project-skill
```

## Project skill vs user skill

- **Project skill**: shared with agents for the current project. Use this for workflows teammates should discover in the repo.
- **User skill**: installed for the current user. Use this for personal workflows or global defaults.

Most team setup should use `--scope project --project-skill`. Global personal setup should use `--scope global --user-skill`.

## What TrailStep writes

For each generated workflow skill, TrailStep writes a skill source under `.trailstep/skills/<skill-name>/SKILL.md` and then attempts to distribute it through the installed skills CLI.

Generated skill names use the workflow registration name with a TrailStep prefix, such as `trst-review`.

The generated skill explains:

- the registered workflow ref to run
- whether input should be written to a file first
- how to call `trailstep <workflow-ref>`
- how to continue or retry through TrailStep instead of inventing a custom resume path

## Packaged TrailStep usage skill

`trailstep init --install-skill` installs the packaged TrailStep usage/authoring skill. That skill teaches agents the general TrailStep workflow lifecycle: authoring, registering, running, continuing, and retrying.

Workflow-generated skills are different: they are per-workflow skills created by `trailstep add --project-skill` or `--user-skill`.

## Scope mismatch warnings

TrailStep warns when a skill target and registration scope are likely to surprise teammates. For example, a project skill pointing at a local registration may not work for others, and a user skill pointing at a project registration only works from that project.

## Regenerate or remove

If a workflow registration changes, re-run `trailstep add` with `--force` when appropriate to refresh generated skill content.

Removing a workflow registration with `trailstep remove` does not aggressively delete generated skill directories. If TrailStep reports that a generated skill directory remains, delete it manually only after confirming no agent still needs it.
