# First release candidate

Scope: one usable local/shared-filesystem workflow, not a live destination integration or registry release.

## Acceptance

1. Acquire a Git source at an explicit ref; inventory skills without executing source code. Preserve competing projections and select exact paths, never union same-name copies.
2. Track upstream revision/content, local Git commit/base/content, candidate, approval, and deployed content separately. Hash every relevant file and executable bit.
3. Explicit installation requests approve the selected complete snapshot. Later changed candidates require exact-hash approval. Autonomous policy defaults to hold, with no automatic permission expansion.
4. Reconcile local edits using Git three-way file merges. Hold conflicts, deletions of selected skills, live drift, and unowned collisions; leave deployed bytes unchanged.
5. Stage on the destination filesystem. Journal one skill replacement at a time, retain previous bytes, recheck drift, and recover interruptions without overwriting unknown content.
6. Cover no-op repeats, supporting scripts, stale approvals, clean patch updates, conflicts, drift, collisions, concurrency, interrupted replacement, restart recovery, and dry runs.
7. Provide inventory/list/profile filters, actionable status, verify, and check-only doctor. Validate fresh install, compiled executable, local package and Node 20/npx/bunx runners.

## Choices for this slice

- Native adapters: conventional `.agents/skills`, `.claude/skills`, `skills`, and local Claude plugin declarations. Cursor/ChatGPT manifest semantics are deferred and fail explicitly.
- Optional replaceable `skills@1.7.2` CLI probe uses listing only in an isolated scratch directory. No SDK assumption; no upstream installer touches the live library.
- Durable immutable manifest plus versioned lock, immutable content objects, acquired repos, local edit Git histories, and reports. Keep this state outside the disposable package runner.
- Portable exclusive directory lock outside durable state, with explicit stale-lock recovery. No automatic lock stealing; Linux `flock` integration remains future work.
- Filesystem deployment requires explicit acknowledgement of coordinated exclusive destination access. It detects observed concurrent writes but cannot lock out another host writer. Grok's sanctioned write/catalog behavior remains unverified.
- Deleting a whole selected skill is held. Three-way file deletion/rename is represented as delete/add and must reconcile without losing local content.
- Reject symlinks, special files, nested repositories, reserved legacy/log files, and unsafe paths. Preserve file bytes and executable bits; do not copy ownership, ACLs, or directory modes. Empty directories are not content.
- Per-skill transactions, no collection-wide atomicity. Retain backups; no automatic backup deletion.
- Optional configurable gardener/primary metadata and shared profile filters; no messaging or live routines.

## Milestones

1. Durable schemas, content trees, Git acquisition/discovery and sidecar history.
2. Inventory/selection, stage/capture/approval, safe apply/recovery and reports.
3. Acceptance fixtures, clean packaging/runner smoke checks, demo, final diff review.

## Architecture alignment

Read [the Grok architecture comparison](grok-bot/architecture-and-gaps.md) before treating this slice as the full proposed product. Detached source generations plus per-skill local histories and file merges intentionally differ from a per-source working branch/rebase. Staging-only sync, portable directory locks, collection-wide fetch failure and filesystem transactions inside the library remain explicit boundaries; live adapter, routine, Linux lock and durable restore work is not complete.
