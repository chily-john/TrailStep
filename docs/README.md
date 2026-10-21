# Documentation

The canonical TrailStep documentation does not live in this repository. It is
stored in OpenViking at:

```text
viking://resources/trailstep/docs/
```

This directory therefore contains pointers only:

- `README.md` (this file) — where the canonical docs live and how to pull them.
- `openviking-setup.md` — the committed setup guide for the local OpenViking
  index (kept in-repo by design).

## Canonical OpenViking doc URIs

Every canonical doc entry, with the URI to read it from:

| Doc | Canonical OpenViking URI |
| --- | --- |
| Getting started | `viking://resources/trailstep/docs/getting-started/getting-started.md` |
| Authoring workflows | `viking://resources/trailstep/docs/authoring-workflows/` (split into section files under `Authoring_workflows/`) |
| Generated skills | `viking://resources/trailstep/docs/generated-skills/generated-skills.md` |
| Scopes and config | `viking://resources/trailstep/docs/scopes-and-config/scopes-and-config.md` |
| CLI reference | `viking://resources/trailstep/docs/cli-reference/` (split into section files under `CLI_reference/`) |
| CLI reference - MCP server | `viking://resources/trailstep/docs/cli-reference/CLI_reference/MCP_server.md` |
| Architecture | `viking://resources/trailstep/docs/architecture/architecture.md` |
| Delegate reliability writeup | `viking://resources/trailstep/docs/delegate-reliability-writeup/delegate-reliability-writeup.md` |
| Design - parallel tracks | `viking://resources/trailstep/docs/design/parallel-tracks/` (split into section files) |
| OpenViking setup guide | `viking://resources/trailstep/docs/openviking-setup/openviking-setup.md` (also committed in-repo as `docs/openviking-setup.md`) |
| This pointer file | `viking://resources/trailstep/docs/README/README.md` |

The `authoring-workflows`, `cli-reference` and `design/parallel-tracks` docs
are large, so OpenViking stores them as several section files whose names
carry a content hash. Link to the doc directory for those, not to a single
section file, so the link stays stable.

## Pulling the canonical docs

If the repo has not been indexed on this machine yet (or the index is stale),
(re)build it from a `pi` agent session:

```text
openviking_add_resource  path = <repo root>,  to = viking://resources/trailstep
```

or from the CLI:

```bash
ov add-resource <repo root> --to viking://resources/trailstep --wait \
  --ignore-dirs "node_modules,dist,.git,.turbo,.trailstep,coverage,.next,.claude,.agents,.pi,.tmp,data,agent"
```

> **Symlink trap (known issue):** a repo-root import fails with an
> `IO Error` when it walks the `.claude` / `.agents` / `.pi` directories,
> because those can be symlinks into the user's agent configuration. Always
> keep them in `--ignore-dirs`.

> **Wipe hazard (important):** OpenViking's sync-to-existing behaviour
> *deletes* entries that are absent from the source. The canonical docs live
> in OpenViking, while the in-repo `docs/` directory only holds pointers, so
> importing `./docs` into `viking://resources/trailstep/docs` would **wipe
> the canonical documentation**. Never sync the in-repo `./docs` directory
> into the canonical docs URI. `scripts/refresh-openviking-index.sh` only
> syncs code trees (`packages/*`, `scripts`, `.github`, `.changeset`,
> `AGENTS.md`) and refuses to touch the docs URI.

If the canonical docs were wiped by a bad import, restore them from git
history:

```bash
scripts/refresh-openviking-index.sh --restore-docs
```

which does, for every doc file present in git history:

```bash
git show HEAD:docs/<file> > <tmpdir>/<file>
ov add-resource <tmpdir> --to viking://resources/trailstep/docs --wait
```

Then browse `viking://resources/trailstep/docs/` with the OpenViking tools:

- `openviking_list` / `openviking_tree` — see the doc tree
- `openviking_read` — read a doc (large docs are split into section files,
  e.g. `docs/cli-reference/CLI_reference/MCP_server.md`)
- `openviking_search` / `openviking_find` — semantic discovery
- `openviking_grep` — exact-text matches

## What used to be here

`architecture.md`, `authoring-workflows.md`, `cli-reference.md`,
`delegate-reliability-writeup.md`, `generated-skills.md`,
`getting-started.md`, `scopes-and-config.md`, and `design/` were moved into the
OpenViking store — each one was verified retrievable there before it was
removed from this repository.

Package-level READMEs (`packages/*/README.md`) remain in the repo: they ship
to npm and are not documentation duplication.

Do not add new documentation files here; write them into
`viking://resources/trailstep/docs/` instead.
