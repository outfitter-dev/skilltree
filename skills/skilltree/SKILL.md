---
name: skilltree
description: Operate the Skilltree release candidate to select, reconcile, review and apply skills while preserving local edits and ownership.
---

Use the configured durable state directory with `--home`; inspect `skilltree --help` and `status` before writing. Never assume a live destination or primary agent is configured. The filesystem adapter needs coordinated exclusive writes; Grok host/catalog integration is unverified.

An explicit user request to install an identified skill can use `select <source> --path <exact-path> --id <id> --install --reason <request>`. Discovery and suggestions alone do not grant that authority. Only manual update policy is implemented. Do not grant yourself more authority over time.

Use `verify` to detect drift. Explicitly requested local-edit adoption uses `capture <id>`, which records a complete snapshot in local Git history. `sync` stages reconciled candidates without applying or approving. Conflicts, drift, and removed selected skills are held; never bypass them with directory cleanup.

Review every candidate file, supporting script, declared dependency, and triage reason. Triage is not a safety guarantee. Approval uses `approve <id> --hash <candidate-hash> --reason <review>`. `apply <id> --hash <same-hash>` accepts only that exact complete approved candidate and an unchanged owned live baseline.

`list --profile <profile>` filters one shared library's metadata, not access. Gardener and optional primary metadata are configurable; there is no automatic messaging or routine creation.

Read JSON output and per-write reports. Use check-only `doctor` for path, lock, object and drift problems. An interrupted replacement requires `recover`; preview with `--dry-run`. Unknown current bytes are never overwritten by recovery. Use `recover --unlock` only when the former process has exited. Preserve retained backups, local histories, immutable objects and authoritative records together.

Do not modify live accounts, routines, credentials or security settings as part of skill management. Installation approval does not authorize every operation described by an installed skill.

## Complete directory recovery

Every actual `apply` must create and verify a full supported-directory recovery point before touching the library. This includes skills outside the lock and host-owned metadata. Save the returned `recoveryPoint` ID. Unsupported or unverifiable backup conditions hold the update; do not override them.

```sh
skilltree backup --home /absolute/state --reason 'Owner requested a recovery point'
skilltree backups --home /absolute/state
skilltree revert --home /absolute/state --snapshot <id> --dry-run
skilltree revert --home /absolute/state --snapshot <id> --expect <current-hash-from-reviewed-diff>
```

Review the added/removed/changed path diff with the owner before a whole-directory revert. It can change outside-lock files, so ordinary skill installation approval is insufficient authority. Revert saves a verified snapshot of current state first, then requires the reviewed current hash to still match. Record `currentRecoveryPoint` so that newer state can also be recovered. Do not promise an unconditional “always”: filesystem support, permissions, integrity and concurrency limits apply.

An interrupted directory revert shares the `recover --dry-run` / `recover` path with skill replacement recovery. Recognized restores finish or roll back; unknown newer bytes hold for inspection. Keep journals and retained directories. `restore` rebuilds generated Git caches from archives and does not restore library contents. The standalone installer restores runner files, not the library.

Whole-directory recovery points live outside the library in durable state and are not discarded by per-skill backup/cache retention. Keep them with their blob store. Unsupported ACLs/xattrs, special files/permissions, hardlinks, external links and owner changes fail closed. macOS-managed provenance and timestamps are excluded from the portable restored metadata contract. Linux requires Python 3 with standard-library xattr APIs. See the bundled [Gardener profile](../../agents/gardener.md).

For an interrupted revert that finds newer supported current data, an explicitly authorized keep-current recovery is available:

```sh
skilltree recover --home /absolute/state --keep-current --dry-run
skilltree recover --home /absolute/state --keep-current --expect <reviewed-current-hash> --quiet-host
```

It verifies a new recovery point before canceling the interrupted restore, keeps current directory bytes and retained prior data, and leaves ownership drift for explicit reconciliation. It does not overwrite newer edits. Repeated completed reverts with unchanged directory and ownership state return CURRENT.

Actual whole-directory revert/recovery requires `--quiet-host` after stopping catalog pickup and other writers through verification. The flag is an attestation, not host control. Doctor reports complete backup capability and offending paths; unsupported outside-lock entries intentionally block backup. Linux uses bundled inspection through Python 3 standard-library xattr APIs, and does not require attr/acl commands.

Explicit `compact --retained-directories --dry-run` and `compact --backup-scratch --dry-run` inspect redundant verified owned copies or checkpointed temps. Run the actual chosen policy only when requested. All recovery points/blobs are retained; unknown, changed, partial or live-owner material holds. Linux timestamps are not restored. Use `--runtime-root` to isolate tests because the default Linux lock uses the passwd home independently of `$HOME`.
