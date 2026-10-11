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
