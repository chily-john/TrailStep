# OpenViking setup (optional)

OpenViking is an optional local context backend for this repo. It indexes the
codebase (per-file abstracts, per-directory overviews, code skeletons, vector
search) and gives the `pi` coding agent recall, per-turn capture, and context
takeover plus `openviking_*` tools (`search`, `find`, `read`, `tree`, `grep`,
`glob`, `add_resource`, ...).

Nothing in TrailStep requires it. The index data is rebuildable and stays out
of git — only this doc and `ov.conf.example` are committed.

## Model choices

Both models run through one OpenRouter key:

- **Embedding:** `qwen/qwen3-embedding-8b`, `dimension: 4096`. This is what
  the vectors are built with — if you change it, delete the workspace data and
  re-index.
- **VLM (recommended):** `qwen/qwen2.5-vl-72b-instruct`. The VLM only writes
  short L0 abstracts (~256 chars) and L1 directory overviews (~4000 chars), so
  pick cheap, fast, and vision-capable (diagrams/screenshots) over big
  reasoning models. It keeps you on the same Qwen/OpenRouter billing.
  - Cheaper fallback on the same provider: `qwen/qwen2.5-vl-7b-instruct`.
  - Non-Qwen alternative: `openai/gpt-4o-mini` via OpenRouter.

## First-time setup

Prereqs: Python 3.10+, Node.js 22.19+, the `pi` agent.

1. Install the server (PowerShell):
   ```powershell
   python -m pip install --upgrade openviking
   ```
2. Get an API key at `https://openrouter.ai/keys` (account + credits +
   Create Key). Paste it only into your **local** config or the `init`
   wizard below — never into chat, never into the repo.
3. Copy the example config and fill in the key:
   ```powershell
   mkdir ~/.openviking -ErrorAction SilentlyContinue
   cp ov.conf.example ~/.openviking/ov.conf
   # edit ~/.openviking/ov.conf, replace your-openrouter-api-key (both spots)
   ```
   Or run `openviking-server init` and enter the values interactively.
4. Validate, then start:
   ```powershell
   openviking-server doctor
   openviking-server
   ```
   Health check: `curl http://localhost:1933/health` and
   `curl http://localhost:1933/ready`. Studio: `http://127.0.0.1:1933/studio`.
   Default bind is localhost-only with no auth — fine for single-machine use.
5. Install the `pi` extension. On macOS/Linux, use the unified installer
   (idempotent):
   ```bash
   curl -fsSL https://openviking.ai/install | bash
   ```
   On Windows (the installer only supports macOS/Linux), install manually:
   ```bash
   git clone --depth 1 https://github.com/volcengine/OpenViking.git ~/.cache/ov-src
   cd ~/.cache/ov-src
   node examples/memory-plugin-shared/sync.mjs
   mkdir -p ~/.pi/agent/extensions/openviking
   cp -R examples/pi-coding-agent-extension/. ~/.pi/agent/extensions/openviking/
   npm ci --prefix ~/.pi/agent/extensions/openviking --omit=dev --ignore-scripts
   ```
   Then ensure `~/.openviking/ovcli.conf` points at your server
   (`"url": "http://localhost:1933"`; no key needed for local dev mode),
   or run the wizard:
   `node ~/.pi/agent/extensions/openviking/scripts/setup.mjs`.
   This drops the extension in `~/.pi/agent/extensions/openviking` (auto-loaded
   on next `pi` start — do not also `pi install` it) and configures
   `~/.openviking/ovcli.conf`. The script needs network access and writes to
   your home directory; run it outside any sandbox if one blocks it.
6. Index this repo with the refresh script (from the repo root):
   ```bash
   scripts/refresh-openviking-index.sh
   ```
   **Do not import the repo root as a single unit.** Two traps:
   - The `.claude` / `.agents` / `.pi` directories can be symlinks into your
     agent configuration, and a repo-root import then fails with an
     `IO Error`. They must stay in `--ignore-dirs`.
   - The canonical documentation lives in OpenViking at
     `viking://resources/trailstep/docs/`, while the in-repo `docs/` folder
     only holds pointers. OpenViking's sync-to-existing behaviour *deletes*
     entries that are absent from the source, so importing the repo root
     would **wipe the canonical docs**.

   The refresh script syncs code trees only (`packages/*`, `scripts`,
   `.github`, `.changeset`, `AGENTS.md`) and refuses to sync `./docs` into
   the canonical docs URI. If an earlier bad import wiped the canonical
   docs, restore them from git history:
   ```bash
   scripts/refresh-openviking-index.sh --restore-docs
   ```
   (that runs `git show HEAD:docs/<file>` into a temp dir and re-imports it
   into `viking://resources/trailstep/docs`).

   A manual equivalent that keeps the traps handled:
   ```bash
   ov add-resource <repo root> --to viking://resources/trailstep --wait \
     --ignore-dirs "node_modules,dist,.git,.turbo,.trailstep,coverage,.next,.claude,.agents,.pi,.tmp,data,agent"
   ```
   — but prefer the script, which never syncs the in-repo `./docs`.
7. Verify in `pi`: footer shows `OV ✓`, `/viking` prints the session mapping
   and registered tool count.

## New machine quick-start

1. `python -m pip install --upgrade openviking`
2. Copy `ov.conf.example` to `~/.openviking/ov.conf`, set the OpenRouter key.
3. `openviking-server doctor` → `openviking-server`
4. Re-run the installer from step 5 above.
5. Re-index the checkout (step 6). Vectors rebuild from source — nothing to
   copy over.

## Notes

- `~/.openviking/ov.conf` and `~/.openviking/data/` are yours alone: never
  commit them. `storage.workspace` uses a local backend, so each machine
  rebuilds its own index.
- If you later turn on server auth, `pi` needs a **user/admin** key for
  `/mcp` — a root key gets 403 there. See `ovcli.conf`.
- Full server reference: `https://docs.openviking.ai/en/guides/01-configuration`.
  `pi` integration details:
  `https://docs.openviking.ai/en/agent-integrations/11-pi`.
