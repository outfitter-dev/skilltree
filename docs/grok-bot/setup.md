# Setting up skilltree on Grok Bot

Status: **proposed Grok integration**. The local release candidate implements a coordinated filesystem workflow; its Grok host write route and catalog pickup remain unverified. This page describes the intended setup so the implementation can target it. Platform facts and their evidence are in [environment.md](environment.md). [Architecture and gaps](architecture-and-gaps.md) records current implementation differences; the layout and routines below remain proposals.

## Layout

| What                       | Path                             | Why                                                                                                        |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Manifest, lock, reports    | `/workspace/skilltree/`          | Always restored after a Computer Update                                                                    |
| Source clones              | `/workspace/skilltree/repos/`    | Same; don't use folder names the sync skips (`node_modules`, `dist`, `build`, `target`, `.venv`, `.cache`) |
| Runner (optional)          | `~/.local/bin/skilltree`         | First on PATH; a convenience, not the source of truth                                                      |
| Run lock and runtime state | `~/.local/state/skilltree/`      | Not restored, so a stale lock can't come back from a snapshot                                              |
| Destination                | `/home/box/sand-data/workflows/` | The shared skill library every bot on the computer reads                                                   |

## Install (proposed)

1. Confirm the actual canonical destination with `realpath`; aliases are refused. Confirm prerequisites: `git --version` and `node --version` (20 or newer). Confirm Python 3 with `os.listxattr`/`os.getxattr` as well. The metadata inspector is embedded in the runner; it does not need getfattr/getfacl. `doctor` checks actual backup capability and reports an offending path. If Python is missing, stop and request an explicit approved, durable Python dependency installation; do not install on the live host autonomously.
2. Install a pinned runner to `~/.local/bin/skilltree`, either a standalone build or a Node 20-compatible package.
3. Configure a verified destination adapter before initializing the live host. The current `init --dest ... --exclusive-dest` supports coordinated filesystem fixtures only; the shared host path is not verified for it.
4. Register sources and inventory exact paths. A user-requested `select --install` approves that installation; autonomous selections are held. Do not use the filesystem adapter on the live host until its write integration is verified.
5. `skilltree doctor` should report OK for runtime, paths, write access, lock and complete-library backup capability. Unknown nonempty legacy catalog folders are errors requiring inspection.
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

## Directory recovery and runtime prerequisites

Whole-directory `revert` and journal recovery require an explicit `--quiet-host` attestation on actual commands. Stop catalog pickup and all other writers for the entire backup/revert/recovery interval. The rename-based swap temporarily removes the directory; a host that recreates it causes a held transaction. The flag documents a caller-established precondition, not a mechanism to stop the host or a concurrency guarantee. Keep the journal and prior directory when held.

Python 3 is an explicit Linux runtime dependency for direct non-following xattr inspection, including POSIX ACL xattrs. Validate the original unmodified release on the target runtime. A temporary PATH containing extracted attr/acl tools is not sufficient acceptance evidence. Durable approved dependency provision and revalidation after Computer Update must be settled before live writes. No dependency or live agent was installed by this project.

The default Linux runtime lock directory uses the operating-system account's passwd home, not `$HOME`; set `--runtime-root` for fixtures or custom placement. A TMPDIR/HOME override alone does not isolate the lock domain.

Installer prefixes are immutable and content-specific. For an approved runner upgrade, choose a new explicit prefix such as `/absolute/runners/<commit-or-artifact-hash>`, pass the exact local artifact and SHA256, and use a separate durable `--state-home`. Verify the new runner, then explicitly select its launcher/PATH; the old prefix and receipt remain available. Installation into an occupied prefix with different bytes holds. Neither install nor `--restore` upgrades Python or restores other OS dependencies.

Whole-library restoration preserves bytes, supported modes/ownership and symlink text. Linux file and directory mtime/atime/ctime are not restored; a host that uses timestamps may detect restored data as changed. No timestamp-dependent host acceptance is claimed.

Retained stage/prior copies can grow. Inspect `compact --retained-directories --dry-run` before explicitly requesting cleanup; only transaction-receipt-owned copies exactly matching verified recovery points qualify. `compact --backup-scratch --dry-run` similarly finds complete checkpointed temps with proven exited writers. Changed, unowned, partially written or live-owner material stays held. All durable recovery points and their blobs remain retained. No cleanup is scheduled.

For this runner, the Linux interpreter is the checked, canonical target of `/usr/bin/python3`; PATH is not used to select it. Doctor shows path/version/SHA256, and missing, writable or changed interpreter identity holds. Record `skilltree --version` and the approved build revision/source hash during isolated verification. The quiet-host flag remains a caller attestation and never controls other writers.

Backup scratch now uses a durable reservation before disposable file creation. Doctor reports held initialization/intent/journal artifacts; incomplete or unknown nonempty bytes are retained for inspection, so zero-artifact cleanup is not guaranteed. The active payload-free reservation journal is bounded at 64 MB and is not rotated automatically. Reviewed `recover --scratch --dry-run`, then `recover --scratch --expect <hash>`, seals original bytes, carries unresolved ownership and supplies a fresh active journal; the same route handles exhaustion. Remove file-size/disk/quota constraints first. Complete recovery points are unaffected.

Rootless user namespaces can report system-root Python as UID 65534; the existing strict trust check fails as intended. No trust exception or interpreter configuration is added. The actual Grok ownership-preserving host shape is unaffected.
