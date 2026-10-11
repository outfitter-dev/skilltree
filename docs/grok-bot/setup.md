# Setting up skilltree on Grok Bot

Status: **proposed Grok integration**. The local release candidate implements a coordinated filesystem workflow; its Grok host write route and catalog pickup remain unverified. This page describes the intended setup so the implementation can target it. Platform facts and their evidence are in [environment.md](environment.md). [Architecture and gaps](architecture-and-gaps.md) records current implementation differences; the layout and routines below remain proposals.

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
3. Configure a verified destination adapter before initializing the live host. The current `init --dest ... --exclusive-dest` supports coordinated filesystem fixtures only; the shared host path is not verified for it.
4. Register sources and inventory exact paths. A user-requested `select --install` approves that installation; autonomous selections are held. Do not use the filesystem adapter on the live host until its write integration is verified.
5. `skilltree doctor` should report OK for the runtime, paths, write access and lock.
6. `skilltree sync --dry-run`, then stage with `sync`, review and approve the exact candidate hash, and explicitly `apply`. Sync never deploys in this release candidate.

## Schedule

There is no cron on a Grok Bot computer. Create a Grok Bot routine on the bot that runs skilltree (see [bot-profile.md](bot-profile.md); suggested name Skill Gardener):

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
