# Local architecture and Grok integration gaps

The accepted local milestone provides controlled filesystem testing on macOS arm64. It does not establish a live Grok destination adapter, catalog behavior, scheduled routine, or snapshot-restoration contract. The additional Linux checks are compatibility fixtures, not tests of the Grok host service.

## Git model

The proposed per-source local working branch (with a configurable name such as `grokbot`) is not implemented. Sources are detached, immutable checkout generations. Local improvements are captured into a separate generated Git history per selected skill, on `skilltree-local`. The lock binds that history's commit and complete content hash to its upstream base.

Reconciliation uses Git three-way file merges over the recorded base, captured local snapshot and fetched upstream snapshot. It does not rebase a source branch. Nonconflicting changes are retained, binary/text conflicts are held, and conflict paths appear in reports rather than in a source checkout's Git index. Supporting files and executable modes are included. The edit repositories are generated provenance, not an interactive workbench: direct edits hold capture/apply. Current capture imports explicit library changes; a branch-authoring interface remains a gap.

This isolates selected skill changes from unrelated repository content and avoids switching or resetting a checkout containing unknown work. It also loses the conventional whole-repository branch/rebase editing workflow. A configurable per-source working branch remains a possible future interface; it must preserve the same explicit capture, provenance and content-approval rules rather than silently replacing this model.

A source's `revision` means its latest accepted fetched snapshot. A conflicting selection retains its earlier per-skill upstream record, local base/hash, approval and deployment; its candidate is cleared. Fetching a newer source does not authorize or deploy conflicting content. This lets different selections from one source have different reconciliation outcomes.

## Sync policy and retention

`sync` stages and reports; it does not perform the proposed combined fetch/reconcile/deploy/notify routine. Only explicit `apply` deploys an exactly approved candidate. Notifications and unattended update policies are not implemented. Draft routine/profile prose describes future integration and must not be treated as a working command contract.

Sources acquire and validate independently. A failed source reports a named error and retains its source and skill records; successful sources stage together in one atomic lock publication. Deployment remains per skill. Single-source failures retain established error codes with source identity. Partial real sync exits nonzero. Structured report events expose source errors and held/conflict/drift selections for a notification consumer; no external messages are sent.

Unchanged syncs reuse the active generation. Changed revisions publish fresh materializations backed by shared immutable Git objects and content-addressed archive manifests. After publication, exact generated tracked bytes from replaced clean worktrees are retired; unknown files and Git metadata stay retained. Durable history is never garbage-collected. Explicit compact policies can bound verified backup copies and reclaim archive-backed generated caches; changed or unknown work holds. Scratch acquisition remains disposable. Archive/index metadata and deliberately retained unknown work can still grow; an automatic destructive retention policy is absent.

## Destination and catalog

New filesystem transactions stage and retain backups in ownership-marked sibling storage outside the destination tree, with same-device checks and versioned location-bound journals. Recursive fixture scans see only active skills. Version 1 journal-owned storage relocates intact outside the catalog through a restartable migration journal before recovery. Report-recognized completed legacy backups relocate intact with migrate-storage. Unknown folders remain held; empty/unrecognized folders warn, while catalog-visible legacy data remains an error.

With `init --adapter grok` or explicit existing-collection `configure --adapter grok`, root host-owned `workflow.md` and `runs.json` are projected out of skill hashes/capture and preserved through replacement. Upstream-authored reserved names remain invalid. This projection does not establish a sanctioned host API or authorize uncoordinated writes.

The actual catalog boundary, refresh/update interface, filesystem topology and writer coordination remain unverified. Same-filesystem rename and fixture scans cannot prove host pickup semantics.

## Locks and persistence

New Linux collections use util-linux flock with a stable destination-keyed sync.lock under ~/.local/state/skilltree, independent of TMPDIR. Explicit runtime roots allow isolated fixtures and coordinated host placement; configuration migration records and locks the previous domain. The parent retains the locked open file description, and Git children inherit it. Process death releases only after all participating descriptors close. macOS/legacy collections keep portable directory locks and explicit stale recovery. Backend transitions hold when the previous locking domain exists; stop older versions before migration. This does not lock host writers or prove that a platform cannot delete runtime directories during active work.

Flat content-addressed Git archives preserve committed provenance without excluded worktree directory names. `restore` validates archive/object digests and accepted revisions, materializes new generations offline and atomically publishes derived pointers. Old paths are retained; modified, staged, unknown or concealed work holds. Approvals, local commit identities and library bytes remain unchanged. `archive` migrates intact legacy state; missing archives hold without network acquisition. Shared Git objects avoid complete history copies for each changed revision.

`demo:restore` actually prunes tracked build content in source and local histories, restores both from archives, and checks standalone digest-verified runner install/restoration after disposable dist loss. It is an isolated harness, not an installed hook or a real Computer Update. Snapshot consistency, inclusion of archives and unsnapshotted work loss still need host evidence.

## Next integration slice

1. Independently review the isolated preservation implementations, including crash/unknown-work behavior and backward compatibility.
2. Establish the real catalog/update contract and filesystem/runtime lifetime through read-only host evidence before selecting a live adapter.
3. Verify real snapshot inclusion/consistency and approved hook order; simulated restoration cannot prove platform behavior.
4. Decide destructive retention and unattended update/notification policy separately. No history/backups are automatically deleted.
5. Configure live routines/hooks only in separately authorized integration work; keep primary-agent integration optional.

The Git-backed fixture suite has a bounded thirty-second per-test deadline to accommodate cold filesystems and emulated Linux verification. This changes test infrastructure only; Git operation limits, application locking and assertions are unchanged.

## Preservation maintenance

Configuration is an explicit migration command, not a live host activation. The Grok filesystem policy preserves host-owned root metadata by default and holds unsupported destination content per skill. Source observation and accepted skill/approval state remain separate, and sync remains staging-only.

Ownership records bind generated files to hashes and modes. Compaction verifies archive provenance, preserves unknown work, packs only verified active Git caches under explicit --caches, and checks that every Git object identity survives packing. Legacy cache compaction retains unproven refs/logs/configuration. Retain-backups chooses a count of verified backup transactions, independently of unknown held folders; it removes no immutable approval/history archives. No automatic history deletion or real-user cleanup policy is installed.

The standalone installer preflights all destinations before writes. --state-home separates approved runner artifacts and receipts from the disposable prefix, so simulated whole-prefix loss can be restored without network installation. Node and Git remain prerequisites. The missing-build launcher already returned nonzero before this work; regression coverage verifies that existing behavior.

Owned stale scratch can be reclaimed only after its owner exits and file records match; incomplete or unrecognized material stays held. Test/demo runtime roots are contained in disposable fixtures. Host snapshot consistency, excluded runtime lifecycle and concurrent sanctioned writers still require real host evidence.
