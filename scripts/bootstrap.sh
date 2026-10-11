#!/usr/bin/env bash
set -euo pipefail

# Worktree hooks must use this checkout, not inherited provider or Git overrides.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR
unset CODEX_WORKTREE_PATH CLAUDE_PROJECT_DIR GITHUB_WORKSPACE FACTORY_PROJECT_DIR

checkout_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$checkout_root"
if [[ "$(git rev-parse --show-toplevel)" != "$checkout_root" ]]; then
  echo "Run setup from a Skilltree checkout." >&2
  exit 1
fi
if [[ ! -f AGENTS.md || ! -L CLAUDE.md || "$(readlink CLAUDE.md)" != AGENTS.md ]]; then
  echo "Expected checkout-local CLAUDE.md -> AGENTS.md; preserve and inspect existing guidance." >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "Install the Bun version in .bun-version before running setup." >&2
  exit 1
fi
bun_pin="$(cat .bun-version)"
if [[ "$(bun --version)" != "$bun_pin" ]]; then
  echo "Setup requires Bun $bun_pin from .bun-version." >&2
  exit 1
fi
bun install --frozen-lockfile --ignore-scripts
bun run check
