# OpenViking setup (optional)

OpenViking is an optional local context backend for this repo. It indexes the
codebase (per-file abstracts, per-directory overviews, code skeletons, vector
search) and gives the `pi` coding agent recall, per-turn capture, and context
takeover plus `openviking_*` tools (`search`, `find`, `read`, `tree`, `grep`,
`glob`, `add_resource`, ...).

Nothing in TrailStep requires it. The index data is rebuildable and stays out
of git — only this doc and `ov.conf.example` are committed.

## Model choices

The setup is **fully free**: embeddings run locally, the VLM runs on OpenRouter
free models.

- **Embedding (local, Ollama):** `qwen3-embedding:0.6b`, `dimension: 1024`.
  Costs nothing, no rate limit, and is materially better on code than the
  smaller `nomic-embed-text` (768). Pull it once:
  ```bash
  ollama pull qwen3-embedding:0.6b
  ```
  The vectors are built with this model — if you change the model **or the
  dimension**, the vector collection has to be rebuilt (see
  *Rebuilding after a model change*).

  `embedding.text_source` is set to `summary_first`: files are vectorised from
  their generated L0 abstract, not their raw bytes. On CPU that is the
  difference between ~50 embeddings/minute and ~2 — a full-file 4k-token
  embedding costs 20-120s on a laptop CPU, a summary costs well under a
  second. It also matches what the index is searched by.
- **VLM (OpenRouter free):** `nvidia/nemotron-3.5-super-vl:free` is the
  primary. The VLM only writes short L0 abstracts (~256 chars) and L1
  directory overviews (~4000 chars), so a cheap vision-capable model is
  enough.
  Free models are rate limited **per day** (1000 requests/day for a funded
  account), so `vlm.credentials` chains several free models in priority
  order. OpenViking fails over to the next credential on 429/5xx and fails
  back after `failback_timeout_seconds`:
  1. `nvidia/nemotron-3.5-super-vl:free` — primary
  2. `openrouter/free` — auto-router onto whichever free model has capacity
  3. `minimax/minimax-m3.1-flash:free` — separate daily pool
  4. `google/gemma-4-26b-a4b-it:free` — Google's pool (often exhausted)

  Each `credentials[]` entry must repeat `api_key`, `api_base` and
  `extra_headers` — credential entries do **not** inherit them from the
  parent `vlm` block.

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
   # edit ~/.openviking/ov.conf, replace your-openrouter-api-key (all spots)
   ```
   Or run `openviking-server init` and enter the values interactively.
   Set `storage.workspace` to an **absolute** path: it is resolved relative
   to the server's working directory, and a relative value silently creates
   a second, empty workspace when the server is started from elsewhere.
4. Validate, then start:
   ```powershell
   openviking-server doctor
   openviking-server
   ```
   Health check: `curl http://localhost:1933/health` and
   `curl http://localhost:1933/ready`. Studio: `http://127.0.0.1:1933/studio`.
   Default bind is localhost-only with no auth — fine for single-machine use.
   `openviking-server` reads `ov.conf` once at startup and does not watch
   it: **restart the server after every config change**.
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

## Rebuilding after a model change

Changing the embedding model or its dimension makes the stored vectors
unusable. The server then refuses to start with:

```
EmbeddingRebuildRequiredError: Existing collection dimension 4096 differs from 1024
```

Rebuild the **vector collection only**:

```bash
# 1. stop the server
# 2. delete the vectors, keep the content tree
rm -rf <workspace>/vectordb/context
# 3. start the server again (it recreates the collection at the new dimension)
# 4. re-embed + regenerate summaries
curl -X POST http://127.0.0.1:1933/api/v1/content/reindex \
  -H "Content-Type: application/json" \
  -d '{"uri":"viking://resources/trailstep","mode":"semantic_and_vectors","force":true,"recursive":true,"wait":false}'
```

`mode` is `vectors_only` (re-embed, no VLM calls, free) or
`semantic_and_vectors` (also regenerates L0 abstracts and L1 overviews —
this is what costs VLM quota). `force: true` redoes work that already
exists.

> **Never delete `<workspace>/viking`.** That tree holds the file contents
> *and* the canonical documentation, which exists nowhere else. Only
> `vectordb/context` is rebuildable.

The reindex runs in the background and survives a server restart — the task
id comes back from the API and can be polled at
`GET /api/v1/tasks/<task_id>`. Watch it with:

```bash
ov observer queue    # per-queue pending / in-progress / requeued / errors
ov observer models   # per-model call counts and token usage
```

## Throughput notes (CPU-only machines)

The local embedder is the throughput bottleneck on a laptop CPU. Two levers
matter, and both are already applied in `ov.conf.example`:

- `embedding.text_source: "summary_first"` — embed the generated L0
  abstract instead of the file's raw bytes. A 4k-token file costs 20-120s to
  embed on CPU; a summary costs well under a second. This is a ~30x
  difference on a full re-index and it also matches what the index is
  searched by.
- Ollama's own parallelism. Ollama serialises embedding requests unless
  `OLLAMA_NUM_PARALLEL` is raised, and it batches concurrent requests into
  one forward pass:

  ```bash
  setx OLLAMA_NUM_PARALLEL 8
  setx OLLAMA_MAX_LOADED_MODELS 1
  # restart ollama afterwards
  ```

  With 8 parallel requests the wall time for a batch is only ~1.2x the time
  of a single request. On Windows the tray app spawns the server, so the
  variables must be set *before* the app starts; the app inherits them.

While a bulk re-index runs, `ov find` can hit its request timeout because the
query embedding queues behind the embedding batch. Give the `pi` extension
more headroom with `OPENVIKING_TIMEOUT_MS=120000` in the environment.

## New machine quick-start

1. `python -m pip install --upgrade openviking`
2. `ollama pull qwen3-embedding:0.6b`
3. Copy `ov.conf.example` to `~/.openviking/ov.conf`, set the OpenRouter key.
4. `openviking-server doctor` → `openviking-server`
5. Re-run the installer from step 5 above.
6. Re-index the checkout (step 6). Vectors rebuild from source — nothing to
   copy over.

## Notes

- `~/.openviking/ov.conf` and the workspace data are yours alone: never
  commit them. The workspace uses a local backend, so each machine rebuilds
  its own index.
- OpenRouter free models reset their daily budget at 00:00 UTC. A big
  reindex can exhaust it; the failover chain keeps working through the
  other pools, and the reindex is resumable after the reset.
- If you later turn on server auth, `pi` needs a **user/admin** key for
  `/mcp` — a root key gets 403 there. See `ovcli.conf`.
- Full server reference: `https://docs.openviking.ai/en/guides/01-configuration`.
  `pi` integration details:
  `https://docs.openviking.ai/en/agent-integrations/11-pi`.
