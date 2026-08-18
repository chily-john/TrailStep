# @trailstep/create-flows

`@trailstep/create-flows` is a public package of reusable, general-purpose TrailStep workflows.

## Workflows

- `takeItAway`: turns an existing conversation or feature request into reviewed planning and story-by-story delivery. Its default registered workflow id is `take-it-away`.
- `grillItAway`: starts with an interactive conversation and then runs the same implementation pipeline. Its default registered workflow id is `grill-it-away`.

## Recommended usage with TrailStep

Install the TrailStep CLI if you do not already have it:

```bash
npm install --global @trailstep/cli
```

Then let `trailstep add` install and register the workflow package. TrailStep will use the target project's package manager when it can detect one.

```bash
# Preview the add without installing, registering, or writing skills.
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --dry-run

# Install/register both workflows in project scope.
trailstep add @trailstep/create-flows@latest --scope project --workflow "*" --yes
```

Run the registered workflow ids:

```bash
trailstep project/take-it-away --input-file feature-request.json
trailstep project/grill-it-away
trailstep retry project/take-it-away <runName>
```

By default, registrations use the workflow ids shown above. You can override a single registration with `--name <name>` when you need a local alias, but the default ids are the recommended path for examples, support, and repeatability.

Input for `take-it-away` is a JSON object:

```json
{
  "conversation": "We need a workflow that exports widget reports..."
}
```

`grill-it-away` starts interactively and does not require an input file.

## Direct package install

If you want to import the workflows from TypeScript or run bundle refs directly after installing them yourself, install the package and its peer dependency in your project:

```bash
npm install @trailstep/create-flows @trailstep/authoring
```

Then direct bundle refs use manifest names:

```bash
trailstep @trailstep/create-flows#takeItAway --input-file feature-request.json
trailstep @trailstep/create-flows#grillItAway
```

Use the equivalent install command for your package manager if you use `pnpm`, `yarn`, or `bun`.

Generated run artifacts live under `.trailstep/runs` by default; inspect them, but do not edit them to recover workflow state.
