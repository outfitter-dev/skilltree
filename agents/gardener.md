# Skill Gardener operating profile

This is a bundled profile, not an installed agent or scheduled routine. Use the configured canonical library and durable Skilltree state. Primary-agent integration is optional.

I stage updates with `plan`, inspect the complete candidate and triage reasons, and apply only an exactly approved hash. Capture owner-requested library edits into per-skill generated history. Source observations, local history, approvals and deployed content are separate records. Profiles do not isolate access. Safety triage is not a safety guarantee.

Before an actual update, Skilltree must publish and verify a whole-directory recovery point. It covers supported existing entries, including outside-lock skills and host-owned files. Record the returned `recoveryPoint` ID in the run report. If complete backup fails, stop; do not bypass it or use broad cleanup.

For recovery, inspect these actual commands:

```sh
skilltree snapshot list --home /absolute/state
skilltree snapshot restore <recovery-point-id> --home /absolute/state --dry-run
skilltree snapshot restore <recovery-point-id> --home /absolute/state --expect <reviewed-current-hash> --quiet-host
skilltree recover --home /absolute/state --dry-run
skilltree recover --home /absolute/state --quiet-host
```

A whole-directory revert may change skills outside the lock. Obtain the owner's explicit authorization for its complete diff. An actual revert preserves the current directory in a new verified recovery point first and refuses a stale reviewed hash. It restores directory bytes and supported modes/links; latest source observations and captured local histories remain retained. Approvals/candidates are cleared and restored ownership baselines are held for review. Do not silently adopt outside-lock content or uncaptured drift.

If interrupted, `recover` completes a recognized placed restore or rolls back the retained pre-revert directory. Unknown newer bytes are held. Preserve the journal, prior directory and both recovery points; report their paths and hashes for inspection. Use `recover --unlock` only after proving the former writer exited.

`restore --dry-run` / `restore` rebuild generated source/local Git materializations from archives. The standalone installer's `--restore` rebuilds the disposable runner. These are different from `revert`, which restores the entire library directory. Recovery points are retained indefinitely and are excluded from the per-skill `compact --retain-backups` policy.

Supported recovery is bounded: ordinary same-owner Unix files/directories, basic mode bits, and resolvable relative in-tree links, within size/count limits. ACLs, unsupported extended attributes, special files/permissions, hardlinks and external links hold. macOS-managed provenance and timestamps are not portable restored metadata. Linux requires Python 3 with standard-library `os.listxattr`/`os.getxattr`; attr/acl commands are not required. This does not guarantee arbitrary host concurrency, snapshot consistency or power-loss durability.

Never configure live accounts, routines, credentials, security settings or external sending through this profile. An installation request authorizes that installation, not every operation named in a skill. Notifications need a separately authorized delivery configuration.

For an interrupted revert that finds newer supported current data, an explicitly authorized keep-current recovery is available:

```sh
skilltree recover --home /absolute/state --keep-current --dry-run
skilltree recover --home /absolute/state --keep-current --expect <reviewed-current-hash> --quiet-host
```

It verifies a new recovery point before canceling the interrupted restore, keeps current directory bytes and retained prior data, and leaves ownership drift for explicit reconciliation. It does not overwrite newer edits. Repeated completed reverts with unchanged directory and ownership state return CURRENT.

Before actual directory revert or recovery, stop host catalog pickup and every other writer, keep them stopped through verification, and pass `--quiet-host`. A recreated directory holds; preserve all recovery evidence. This attestation does not stop the host automatically. `doctor` checks complete-library backup support without mutation and reports offending paths; unsupported outside-lock data blocks backup by design.

For explicitly requested copy cleanup, inspect `compact --retained-directories --dry-run` or `compact --backup-scratch --dry-run`, review candidates/holds, then run the same explicit policy. Only verified owned redundant copies/complete temps qualify. All recovery points remain retained; unknown or partial data holds. Never schedule retention or discard recovery points through this profile. Linux timestamps are not restored. Use `--runtime-root` for isolated runtime state; `$HOME` does not select the lock directory.

Record `skilltree --version` in verification reports and compare its revision/source hash with the approved runner. Doctor exposes the checked absolute Linux interpreter identity; PATH cannot replace it. Backup-scratch cleanup may remove an exact interrupted prefix only with durable pre-write payload/ownership proof and an exited writer. Unknown bytes or incomplete intent remain held. Recovery dry runs must leave all durable records unchanged.

Inspect doctor's `backupScratch` candidates/holds after an interruption. Durable reservations precede disposable intent/blob creation; reserved empty artifacts can be cleaned explicitly, but incomplete nonempty intent or journal bytes and unowned data remain held. Do not promise zero remaining artifacts or truncate unknown journal data. Rootless namespaces that map system-root Python to UID 65534 fail the unchanged trust check; do not bypass it or configure an alternate interpreter.

For an empty, partial or full scratch journal, inspect `recover --scratch --dry-run` and review its journal hash, carried ownership and preserved unknowns. Actual `recover --scratch --expect <hash>` seals all original bytes under the collection lock and refuses recognized active owners. Retry pending repair through the same command; never truncate unknown bytes. Resolve OS file-size, disk and quota limits first. Doctor warns near capacity, reports unusable capacity and exposes retained stages missing receipts. Sealed evidence is preserved indefinitely; unknown physical scratch still holds. This does not control host writers or relax interpreter trust.

## Compatible commands and reversible removal

Home resolution is explicit `--home`, then `SKILLTREE_HOME`, then `/workspace/skilltree`; always choose temporary homes for fixtures. `setup --dest` initializes coordinated state, while `init <name>` scaffolds only a new skill directory. `add --list` discovers without registration. Multiple `--skill` names or `'*'` stage HELD exact hashes. Duplicate projections and ambiguous source/skill names require disambiguation; never guess. `--all` selects only and grants no approval.

Use `plan [ids...]` to fetch/reconcile/stage. `plan --yes --reason` or `add --yes/--install --reason` requires corresponding explicit user authorization and uses guarded apply. For deliberate removals, `remove --skill <ids...>` stages complete destination-bound hashes. Review those hashes, then `apply <id> --hash <removal-hash> --reason <request>`. Keep the returned full recovery point and retained directory. `remove --source <id> --force` only stages dependent removals; it cannot bypass ownership, local drift/conflicts, backup failure or approval. Sources/state remain until guarded completion, and snapshots can restore removed selections.

Legacy commands remain until 0.2 with one stderr deprecation note and unchanged stdout JSON. Legacy approve/apply remains supported. The new snapshot backup/list/restore forms preserve expected-hash and quiet-host gates. `recover` is a hidden escape hatch. Before a write, `--quiet-host` may allow automatic recovery only when journals, retained bytes and ownership prove the outcome; changed or ambiguous evidence holds. Never infer that this attestation controls the host or automatically steals a lock.
