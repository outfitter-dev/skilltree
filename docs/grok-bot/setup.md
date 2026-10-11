# Setting up skilltree on Grok Bot

Status: **proposed**. skilltree is a scaffold; none of these commands exist yet. This page describes the intended setup so the implementation can target it. Platform facts and their evidence are in [environment.md](environment.md).

## Layout

| What                       | Path                              | Why                                                                                                        |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Manifest, lock, reports    | `/workspace/skilltree/`           | Always restored after a Computer Update                                                                    |
| Source clones              | `/workspace/skilltree/repos/`     | Same; don't use folder names the sync skips (`node_modules`, `dist`, `build`, `target`, `.venv`, `.cache`) |
| Runner (optional)          | `~/.local/bin/skilltree`          | First on PATH; a convenience, not the source of truth                                                      |
| Run lock and runtime state | `~/.local/state/skilltree/`       | Not restored, so a stale lock can't come back from a snapshot                                              |
| Destination                | `/home/box/agent-data/workflows/` | The shared skill library every bot on the computer reads                                                   |

## Install (proposed)

1. Confirm prerequisites: `git --version` and `node --version` (20 or newer). Both ship with the image.
2. Install a pinned runner to `~/.local/bin/skilltree`, either a standalone build or a Node 20-compatible package.
3. `skilltree init --home /workspace/skilltree --dest /home/box/agent-data/workflows`
4. `skilltree add <owner/repo>` for each source. New sources start disabled, and every skill is held on first sync until approved.
5. `skilltree doctor` should report OK for the runtime, paths, write access and lock.
6. `skilltree sync --dry-run`, then review, approve and sync.

## Schedule

There is no cron on a Grok Bot computer. Create a Grok Bot routine on the bot that owns skill hygiene (for example, Skill Gardener):

- **Schedule:** nightly, around 2 AM local time. Use an off-minute, not :00 or :30.
- **Prompt (template):** "`cd /workspace/skilltree` and run `skilltree sync`. If the runner is missing, report that and stop. If the result is UPDATED, CONFLICT, HELD or ERROR, follow the `skilltree` skill. Otherwise stay silent."
- Document the routine as a true schedule with a review date, following your routine rules.

## Recovery after a Computer Update

- An update replaces system paths with the image's copies and stops background processes. `/workspace` and the skill library survive.
- Optional hook: an idempotent `restore_skilltree` step in the computer's after-update script. It reinstalls the pinned runner if it's missing, checks the Node major version, recreates `~/.local/state/skilltree/`, and runs a check-only `skilltree doctor`.
- The hook never syncs, rewrites the lock or approvals, prints secrets, or uses sudo.

## Notifications (proposed)

- **Config:** `notify.webhook` (for example, a Grok Bot routine's webhook trigger URL and auth header), `notify.command`, or `notify.file`.
- **When:** one event per run with UPDATED, CONFLICT, HELD or ERROR. A clean run sends nothing.
- **Event contents:** the run id, the result for each skill, held reasons, a diff summary and lock changes.
- The receiver dedups on the run id.
