#!/usr/bin/env bash
# Refresh the OpenViking index for the TrailStep repo in chunks.
#
# WHAT THIS SCRIPT DOES
#   * syncs CODE TREES ONLY (packages/*, scripts, .github, .changeset and
#     AGENTS.md) into viking://resources/trailstep/...
#   * NEVER syncs the in-repo ./docs directory into the canonical docs URI.
#
# WIPE HAZARD (read before running anything similar by hand)
#   The canonical TrailStep documentation lives in OpenViking at
#   viking://resources/trailstep/docs/ - it does NOT live in this repository.
#   The in-repo ./docs directory only holds pointer files. OpenViking's
#   sync-to-existing behaviour DELETES entries that are absent from the
#   source, so syncing ./docs into viking://resources/trailstep/docs would
#   WIPE the canonical documentation. This script refuses to do that.
#
#   Restore recipe if the canonical docs were wiped by a bad import:
#     scripts/refresh-openviking-index.sh --restore-docs
#   which does, for every doc file that exists in git history:
#     git show HEAD:docs/<file> > <tmpdir>/<file>
#     ov add-resource <tmpdir> --to viking://resources/trailstep/docs --wait
#
# SYMLINK TRAP (known issue, keep the ignore list intact)
#   A repo-root import fails with an IO Error when it walks the
#   .claude / .agents / .pi directories, because those can be symlinks into
#   the user's agent configuration. They are ALWAYS excluded below
#   (--ignore-dirs). If you change the ignore list, keep .claude, .agents
#   and .pi in it - and never import the repo root as a single unit.
#
# Usage: scripts/refresh-openviking-index.sh [--restore-docs] [--dry-run]
set -u

REPO_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

ROOT="viking://resources/trailstep"
CANONICAL_DOCS_URI="$ROOT/docs"
IGNORE="node_modules,dist,.git,.turbo,.trailstep,coverage,.next,.claude,.agents,.pi,.tmp,data,agent"

RESTORE_DOCS=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --restore-docs) RESTORE_DOCS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

warn() {
  printf '\n!!! %s\n\n' "$*" >&2
}

note() {
  printf '%s\n' "$*"
}

require_ignored() {
  # The symlink trap: these directories must never be walked by an import.
  local missing=""
  for d in .claude .agents .pi; do
    case ",$IGNORE," in
      *",$d,"*) ;;
      *) missing="$missing $d" ;;
    esac
  done
  if [ -n "$missing" ]; then
    warn "REFUSING TO RUN: the ignore list is missing$missing.
Importing those directories can fail with an IO Error (they may be symlinks
into the user's agent configuration). Add them back to IGNORE in
scripts/refresh-openviking-index.sh before retrying."
    exit 1
  fi
}

guard_not_docs() {
  # Belt and braces: never point an import at the canonical docs URI from
  # the in-repo ./docs source.
  local local_dir="$1" target="$2"
  case "$target" in
    "$CANONICAL_DOCS_URI" | "$CANONICAL_DOCS_URI/" | "$CANONICAL_DOCS_URI"/*)
      warn "REFUSING TO SYNC $local_dir -> $target.
$CANONICAL_DOCS_URI holds the canonical documentation. Syncing the in-repo
pointer files there would DELETE the canonical docs (OpenViking removes
entries that are missing from the source)."
      exit 1
      ;;
  esac
  case "$local_dir" in
    ./docs | ./docs/ | docs | docs/)
      warn "REFUSING TO SYNC $local_dir -> $target.
The in-repo docs directory holds pointers only; it must never be imported
into the canonical OpenViking docs URI."
      exit 1
      ;;
  esac
}

sync_dir() {
  local local_dir="$1" target="$2"
  guard_not_docs "$local_dir" "$target"
  note "--- syncing $local_dir -> $target"
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  timeout 900 ov add-resource "$local_dir" --to "$target" --wait --timeout 800 \
    --ignore-dirs "$IGNORE" --reason "TrailStep index refresh" 2>&1 \
    | grep -E "root_uri|IO Error|Request Timeout|failed_files" | head -n 3
}

restore_docs_from_git() {
  local tmp file
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t trailstep-docs)"
  note "--- restoring canonical docs from git history into $tmp"
  # shellcheck disable=SC2012
  for file in $(git ls-tree -r --name-only HEAD docs/ | grep -E '\.md$'); do
    local rel="${file#docs/}"
    mkdir -p "$tmp/$(dirname "$rel")"
    if git show "HEAD:$file" >"$tmp/$rel" 2>/dev/null; then
      note "    restored docs/$rel"
    else
      warn "could not read HEAD:$file from git history"
    fi
  done
  if [ "$DRY_RUN" -eq 1 ]; then
    note "    (dry run) would run: ov add-resource $tmp --to $CANONICAL_DOCS_URI --wait"
    return 0
  fi
  note "--- syncing $tmp -> $CANONICAL_DOCS_URI"
  timeout 900 ov add-resource "$tmp" --to "$CANONICAL_DOCS_URI" --wait --timeout 800 \
    --ignore-dirs "$IGNORE" --reason "TrailStep canonical docs restore from git history" 2>&1 \
    | grep -E "root_uri|IO Error|Request Timeout|failed_files" | head -n 3
  note "    temp dir kept for inspection: $tmp"
}

require_ignored

if ! command -v ov >/dev/null 2>&1; then
  warn "the 'ov' CLI is not on PATH; install OpenViking CLI before refreshing the index."
  exit 1
fi

if [ "$RESTORE_DOCS" -eq 1 ]; then
  restore_docs_from_git
  note "=== DONE (docs restored) ==="
  exit 0
fi

warn "The canonical documentation lives in OpenViking at $CANONICAL_DOCS_URI.
This script NEVER syncs the in-repo ./docs directory into that URI, because
OpenViking's sync-to-existing behaviour deletes entries that are missing
from the source - the in-repo docs/ folder only holds pointers, so importing
it would WIPE the canonical docs.

If the canonical docs were wiped by a bad import, restore them with:
    scripts/refresh-openviking-index.sh --restore-docs
which reads each doc from git history (git show HEAD:docs/<file>) and
re-imports it (ov add-resource <tmpdir> --to $CANONICAL_DOCS_URI).

Also note the symlink trap: .claude / .agents / .pi must stay in the
--ignore-dirs list, otherwise an import can fail with an IO Error."

note "=== refreshing code trees only ==="

# packages
for d in packages/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  sync_dir "./$d" "$ROOT/packages/$name"
done

# other code trees
sync_dir "./scripts" "$ROOT/scripts"
sync_dir "./.github" "$ROOT/github"
sync_dir "./.changeset" "$ROOT/changeset"

# root files
note "--- syncing root files"
if [ "$DRY_RUN" -eq 1 ]; then
  note "    (dry run) would sync ./AGENTS.md -> $ROOT/AGENTS"
else
  timeout 600 ov add-resource "./AGENTS.md" --to "$ROOT/AGENTS" --wait --timeout 500 \
    --ignore-dirs "$IGNORE" --reason "TrailStep index refresh" 2>&1 \
    | grep -E "root_uri|Error" | head -n 2
fi

note "=== DONE ==="
note "Canonical docs were NOT touched. They stay at $CANONICAL_DOCS_URI."
