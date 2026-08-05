#!/usr/bin/env bash
set -u
export STEPKIT_BRANCH='stepkit/project-take-it-away-20260805T174330Z'
export STEPKIT_GIT_ISOLATED='worktree'
export STEPKIT_SOURCE_REPO='C:\Users\cjohnson_xtivia\Desktop\StepKit'
export STEPKIT_STORY_COMMIT_MODE='enabled'
export STEPKIT_WORKTREE='C:\Users\cjohnson_xtivia\Desktop\StepKit\.stepkit\worktrees\project-take-it-away-20260805T174330Z'
node packages/cli/dist/index.js project/take-it-away --input-file .stepkit/inputs/project-take-it-away-input.json
status=$?
if [ "$status" -ne 0 ]; then
  echo "StepKit workflow failed with exit code $status"
  exit "$status"
fi
remote=$(git remote | grep -Fx origin || git remote | head -n 1)
if [ -n "$remote" ]; then
  git push -u "$remote" stepkit/project-take-it-away-20260805T174330Z || exit $?
  if command -v gh >/dev/null 2>&1; then
    gh pr create --fill --head stepkit/project-take-it-away-20260805T174330Z || true
  else
    echo "gh not found; open PR manually from branch stepkit/project-take-it-away-20260805T174330Z"
  fi
else
  echo "No git remote configured; push/PR skipped."
fi
