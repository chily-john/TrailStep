---
name: trailstep
description: Use when installing, configuring, updating, or running TrailStep workflows and providers with the TrailStep CLI.
---

# TrailStep usage skill

Use TrailStep to install, discover, run, continue, retry, and observe durable typed coding-agent workflows from project files or packages.

## CLI quick start

- Create config and install the packaged TrailStep skills with `trailstep init`.
- Update TrailStep and refresh tracked packaged skills with `trailstep update`; use `trailstep update --project` only when intentionally updating project authoring/runtime packages.
- Configure agent targets with `trailstep agents` or `trailstep agents set <name> --provider <provider> --scope <project|global>`.
- List registered workflows with `trailstep workflows`.
- Add reusable workflow packages with `trailstep add <package-or-ref>`; request generated workflow skills with `--project-skill` or `--user-skill` when supported agents should discover those workflows from their agent UI.
- Run a workflow with inline JSON: `trailstep <workflow-ref> --input '{"request":"..."}'`.
- Run a workflow with a JSON input file: `trailstep <workflow-ref> --input-file .trailstep/inputs/input.json`.
- Continue waiting or interrupted runs with `trailstep continue`.
- Answer human/parent waits with `trailstep answer <runName> <waitId> --json '{"answer":"..."}'`.
- Retry failed work with `trailstep retry <workflow-ref> <runName>`; retry instead of inventing a separate resume mechanism.
- Inspect active/history with `trailstep runs`, `trailstep watch`, and `trailstep output <runName>` when available in the installed CLI version.
- Manage run artifact lifecycle with `trailstep storage status`, `trailstep storage gc --dry-run`, `trailstep storage restore <runId>`, `trailstep storage pin <runId>`, and `trailstep storage delete <runId>`.
- Open a managed standalone agent session with `trailstep open [agent-or-provider]` or bare `trailstep` when a default agent is configured.

## Workflow refs

TrailStep accepts these workflow reference forms:

- direct refs such as `./workflows/review.ts#review`
- registered refs such as `project/review`
- bundle refs such as `@acme/workflows#review`

Use direct refs for local files, registered refs for named project or user workflows, and bundle refs for exported workflows from installed packages.

## Inputs and generated skills

- Workflow inputs should be JSON object values, not raw prose or arrays.
- Prefer `--input-file` for large context and reproducible runs.
- Generated workflow skills are separate from the packaged TrailStep usage/authoring skills. They are created by `trailstep add` for specific installed workflows and should describe when an agent should invoke that workflow.
- Use project skills for team-shared repository workflows and user skills for personal/global workflows.

## Safety and run artifacts

- Do not manually edit `.trailstep/runs`.
- Local run artifacts are runtime outputs, not source of truth.
- Configure filesystem run cleanup under `storage.lifecycle` with duration strings such as `compressAfter: "7d"` and `deleteAfter: "30d"`; per-workflow overrides live under `storage.lifecycle.workflows`.
- `trailstep storage gc` applies the configured lifecycle and skips pinned runs. `restore` refuses to overwrite hot runs and removes the archive copy after success. `pin`/`unpin` operate on hot runs; restore archived runs first. `delete` removes hot or archived runs but refuses pinned runs.
- Use `trailstep continue` for normal continuation and `trailstep retry` for failed steps instead of adding a custom resume path.
- Keep reusable workflow behavior in workflow source and package exports, not in generated run directories.
- If TrailStep reports that the CLI or packaged skills are out of date, run `trailstep update`.

## Provider usage and authoring

Use provider commands when connecting TrailStep to a coding-agent CLI or package.

Common commands:

- `trailstep providers add <path-or-package> --scope project`
- `trailstep providers inspect <path-or-package>`
- `trailstep providers test <provider> --scope project`
- `trailstep agents set default --provider <provider> --scope project`

Author either a manifest-only provider or a hook-based provider package.

### Manifest-only provider

Create a `my-provider.trailstep-provider.json` file with serializable data only:

```json
{
  "schemaVersion": 1,
  "id": "example",
  "displayName": "Example Provider"
}
```

Do not embed functions in manifests.

Working args may use `{{promptFile}}`, `{{outputFile}}`, `{{model}}`, and `{{thinking}}`. Interactive args may also use `{{prompt}}`. Guard optional overrides with `{{#model}} ... {{/model}}` and `{{#thinking}} ... {{/thinking}}` conditional blocks.

### Hook-based provider package

Export `trailstepProvider` from the package root and keep hooks beside the manifest:

```ts
export const trailstepProvider = {
  manifest: {
    schemaVersion: 1,
    id: "example",
    displayName: "Example Provider",
  },
  hooks: {
    beforeWorkingAgent: async () => undefined,
  },
};
```

Hook-based provider packages may execute provider package code and should be trusted like installed npm dependencies.

Provider authoring checklist:

- provider id
- display metadata
- working invocation
- prompt delivery
- output parsing
- model flags
- thinking flags
- env requirements
- interactive support
- repair support
- resume support
- `trailstep providers inspect <path-or-package>`
- `trailstep providers test <provider> --scope project`
