# Local architecture and Grok integration gaps

The accepted local milestone provides controlled filesystem testing on macOS arm64. It does not establish a live Grok destination adapter, catalog behavior, scheduled routine, or snapshot-restoration contract. The additional Linux checks are compatibility fixtures, not tests of the Grok host service.

## Git model

The proposed per-source local working branch (with a configurable name such as `grokbot`) is not implemented. Sources are detached, immutable checkout generations. Local improvements are captured into a separate generated Git history per selected skill, on `skilltree-local`. The lock binds that history's commit and complete content hash to its upstream base.

Reconciliation uses Git three-way file merges over the recorded base, captured local snapshot and fetched upstream snapshot. It does not rebase a source branch. Nonconflicting changes are retained, binary/text conflicts are held, and conflict paths appear in reports rather than in a source checkout's Git index. Supporting files and executable modes are included. The edit repositories are generated provenance, not an interactive workbench: direct edits hold capture/apply. Current capture imports explicit library changes; a branch-authoring interface remains a gap.

This isolates selected skill changes from unrelated repository content and avoids switching or resetting a checkout containing unknown work. It also loses the conventional whole-repository branch/rebase editing workflow. A configurable per-source working branch remains a possible future interface; it must preserve the same explicit capture, provenance and content-approval rules rather than silently replacing this model.

A source's `revision` means its latest accepted fetched snapshot. A conflicting selection retains its earlier per-skill upstream record, local base/hash, approval and deployment; its candidate is cleared. Fetching a newer source does not authorize or deploy conflicting content. This lets different selections from one source have different reconciliation outcomes.

## Sync policy and retention

`sync` stages and reports; it does not perform the proposed combined fetch/reconcile/deploy/notify routine. Only explicit `apply` deploys an exactly approved candidate. Notifications and unattended update policies are not implemented. Draft routine/profile prose describes future integration and must not be treated as a working command contract.

All sources are currently acquired before a collection update is published. One failed fetch aborts the run without changing accepted state, including otherwise healthy sources. This is a conservative collection policy with an availability cost, not per-source failure isolation. A future mode should report each failed source, preserve its previous state, continue independent sources, and commit successful changes atomically without implicitly granting approvals.

Unchanged syncs reuse the verified active generation. Changed revisions and interrupted generations remain retained; unknown notes are never automatically removed. Scratch clones are still rebuilt each run. Deduplicated Git object storage and owner-approved, ownership-aware retention are future work. Backup and generation retention can consume substantial disk space.

## Destination and catalog

The filesystem adapter currently stages and retains backups inside hidden transaction folders under the destination. A top-level-only catalog scan sees the active skill; a recursive scan can also see its retained `backup/SKILL.md`. An isolated scanner demonstrates this difference. Whether Grok's catalog recursively scans or ignores such folders is unverified.

Do not assume hidden directories are excluded. Before a Grok adapter is accepted, define its catalog boundary and sanctioned write interface. Stage and retain backups outside that boundary on a verified compatible filesystem, validate replacement/recovery behavior, and test catalog results after success, failure and restart. Moving transaction paths also needs backward-compatible recovery of existing journals and an explicit permissions/mount policy. Mock catalog tests cannot prove live host pickup semantics.

## Locks and persistence

The local candidate uses an exclusive directory lock keyed by destination under the OS temporary directory. It serializes cooperating runs sharing that runtime directory. A killed process leaves a lock requiring explicit recovery after proving the PID exited. It is not the proposed Linux `flock -n` lock under an excluded runtime-state directory, and it does not prevent host writes.

The Linux Grok integration still needs a kernel-held lock backend with a tested subprocess/descriptor lifetime, process-exit release, same-destination contention and runtime-location policy. Merely wrapping a second unrelated lock path would not establish those guarantees.

The documented Computer Update directory exclusions can remove tracked `build`, `dist`, `target` or cache paths inside source and local-history working trees. An isolated pruning fixture makes `doctor` report ERROR and sync hold SOURCE_DIRTY; approved immutable content remains available, and the library is not silently changed. Failing closed protects content but is not successful platform recovery.

Avoiding excluded names only at the state root is insufficient. Durable Git/content archives need a layout unaffected by those exclusions, with disposable checkouts materialized outside restored state. A restore path must distinguish missing generated material from real edits, retain unknown work, verify exact commit/content provenance and never rewrite approvals implicitly.

`demo:restore` demonstrates loss of a disposable runner, restoration from a digest-verified local artifact, and check-only doctor/verify against unchanged durable state. It also demonstrates the incomplete-snapshot hold. It is an isolated harness, not a public `restore` command, installed hook, network installer or live Computer Update test.

## Next integration slice

1. Specify a destination adapter contract around the sanctioned host interface and catalog boundary; test it with an isolated host/catalog fixture before any live acceptance.
2. Introduce durable archive/materialization and explicit restore contracts; cover excluded paths, rollback snapshots, unknown local work and runner reinstall.
3. Implement and test the Linux kernel lock backend and runtime location. Keep host-writer coordination explicit.
4. Add source-isolated acquisition/reporting and bounded retention only with documented ownership and approval semantics.
5. Run Linux x64 Node 20/native/package checks and verify actual host behavior separately. Read-only CI and container results cannot establish live integration.
6. Configure routines, notifications, keeper hooks or live installation only through separately authorized host integration work.
