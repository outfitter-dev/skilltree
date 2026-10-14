# Skilltree

Skilltree synchronizes selected skills from Git repositories into one shared library while retaining local edits and approving exact content snapshots.

## Status

`@outfitter/skilltree@0.1.0-rc.1` is the verified published npm release candidate on the `rc` dist-tag. `latest` currently remains `0.1.0-rc.0`; release promotion is a separate reviewed decision. The filesystem workflow is implemented and tested in isolated fixtures. Live Grok deployment, host catalog pickup, and Cursor/ChatGPT plugin ingestion remain unverified or unsupported.

RC1 includes isolated discovery holds and large-file validation fixes. This source checkout adds command compatibility and reversible removals for the next candidate; those additions are not published merely because they are present here.

The CLI provides Git acquisition, normalized inventory, explicit selection, shared profile assignments, local-edit capture, three-way reconciliation, staging, exact-hash approval, apply, verification, diagnostics, and interrupted-replacement recovery. `plan` stages by default. Only explicit `--yes`/`--install` with a reason can activate its exact staged candidates through guarded apply. `--all` only selects; it supplies no approval.

## Getting started

Use Git and Bun 1.4.2 for source development. Run the CLI against a directory whose writes you coordinate; the filesystem adapter does not lock out a host application.

```sh
bun install --frozen-lockfile
bun run check
bun run dev -- --help
```

Choose durable state and destination paths separately from the source checkout and disposable runner. Paths must be canonical and free of symlink components. Sources must be committed Git repositories.

```sh
bun run dev -- setup --home /absolute/collection --dest /absolute/shared-skills --exclusive-dest
bun run dev -- add owner/repo --home /absolute/collection --list
bun run dev -- add owner/repo --home /absolute/collection --source upstream --ref main --skill example --profile gardener --yes --reason 'User requested this specific installation'
bun run dev -- list --home /absolute/collection --profile gardener
bun run dev -- verify --home /absolute/collection
```

`add --skill <name> --yes --reason <request>` records the specific installation request against the complete selected snapshot and uses the same backed-up apply path. It assumes an authorized operator: automated callers must have the corresponding user authorization. Registration with `add` or discovery alone never supplies installation approval. Without both explicit `--yes`/`--install` and a nonempty reason, selection is HELD with its exact candidate hash. `--skill`/`-s` accepts multiple names or `'*'`; duplicate names never pick a projection implicitly. Use an exact skill path or `--id` for a single custom destination. `owner/repo@skill` qualifies repository selection. `--source` remains an explicit override; otherwise its lowercase owner/repo-based ID is derived. `--full-depth` searches below root skills. `add --list` clones into disposable scratch for discovery and never registers a source or writes library state.

## Command compatibility and safe removal

`--home` is optional: the explicit flag wins over `SKILLTREE_HOME`, then the Grok adapter default is `/workspace/skilltree`. Tests and scratch workflows should keep an explicit temporary home. `init <name>` creates a new `<name>/SKILL.md`; it refuses existing paths. Bare `init` requires a name and never chooses a live destination. State initialization is `setup --dest ... --exclusive-dest`.

Aliases are `a` (`add`), `ls` (`list`), `rm` (`remove`) and `update`/`upgrade` (`plan`). `list --json` is accepted because output is already JSON; `list -a` filters profile metadata. Unsupported agent/scope flags consume their values and warn on stderr. `-h`, `-v`, and command help are supported. Search/use proxies, experimental lock ingestion and Skillset integration remain deferred.

```sh
skilltree plan example --home /absolute/collection
skilltree apply example --home /absolute/collection --hash <candidate-hash> --reason 'Reviewed complete content'
skilltree remove --skill example --home /absolute/collection
skilltree apply example --home /absolute/collection --hash <removal-hash> --reason 'Owner requested removal'
```

Removal hashes bind the owned selection and its complete destination, including host metadata. Staging retains the selection, source, local histories and deployed bytes. Actual removal verifies a full-library recovery point, retains the moved directory outside the catalog, and retires ownership only after the journaled operation completes. `snapshot restore` can restore the removed selection and its bytes. Drift, conflicts, unknown ownership or failed backups hold the operation. `remove --all` selects all owned entries and never authorizes deployment.

`remove --source <source-id>` refuses selected skills. `--force` stages their guarded removals and keeps the source until the last one completes; it does not relax approval, hash, ownership, backup or recovery gates. An unused source can be removed with its verified recovery point and retained archives. Ambiguous positional source/skill names require `--source` or `--skill`.

Until 0.2, `select`, `inventory`, `init --dest`, `sync`, `approve`, `capture`, `backup`, `backups` and `revert` retain their stdout JSON contracts and print one deprecation line on stderr. Legacy `approve --hash --reason` followed by `apply --hash` still works. `sync` remains staging only. `recover` remains available through command help but is hidden from primary help. Recognized interrupted transactions can recover before a write with `--quiet-host` after stopping all host writers; ambiguous or changed ownership/bytes stop for inspection. No lock is stolen automatically.

## Updates and local edits

The library is shared; profile filtering is metadata, not access isolation. Optional `--gardener` and `--primary` on `setup` record configurable profile metadata. No agents, messages, routines, or integrations are started.

When an owned deployed skill has local edits, `verify` reports drift. Explicitly adopt those edits with `snapshot <id>` before planning. Snapshot adoption clears the candidate; plan must reconcile and restage before approval:

```sh
bun run dev -- snapshot example --home /absolute/collection
bun run dev -- plan --home /absolute/collection --dry-run
bun run dev -- plan --home /absolute/collection
bun run dev -- status --home /absolute/collection
```

Review the `candidate.hash`, complete content object, reasons, and local/upstream changes in the JSON status and durable objects. Then name that exact hash:

```sh
bun run dev -- apply example --home /absolute/collection --hash <candidate-hash> --reason 'Reviewed the complete content and dependencies'
```

Hashes include every skill file's path, bytes, and executable bit. Changing a supporting script changes approval scope. Git three-way file merges retain nonconflicting local changes; conflicting or removed selected skills are held. A changed candidate cannot use a stale approval. Manual policy is the only unattended-update policy in this candidate; authority never expands automatically.

Triage flags changed scripts and potentially sensitive instructions. It prioritizes review and cannot establish safety. Skilltree never executes a source skill's scripts, and approval to install does not authorize every action in the skill.

## Durable state and recovery

- `skilltree.json`: immutable destination, adapter, gardener/primary metadata, manual policy.
- `skilltree.lock`: selections and profiles; distinct upstream, local base/hash/Git commit, candidate, approval, observed local baseline, and last deployment records.
- `objects/`: immutable complete file snapshots, checked against their SHA-256 on use.
- `repos/`: acquired Git sources; do not treat them as local edit workspaces. Sync fetches and validates in scratch, copies new checkout generations, then atomically publishes their references in the lock. Accepted checkouts are never advanced in place; unchanged syncs reuse their verified generation. Prior or interrupted generations are retained; there is no automatic cleanup.
- `edits/`: local Git histories. `snapshot <id>` records local library edits here; ignored and untracked files, hidden index flags, and changed bytes or modes are preserved and block capture/apply. History updates replace only files owned by a verified recorded snapshot.
- `archives/`, `archive-objects/`, `git-objects/`: digest-bound archive manifests, deduplicated durable Git objects and shared derived Git object storage. File-based objects avoid excluded directory names inside committed sources.
- `reports/`: per-write JSON receipts with run IDs.
- `transaction.json`: interrupted per-skill replacement journal, when present.

Keep the entire state directory, including archives, objects and local history, backed up. Manifest/lock files alone cannot recover local patches. Do not store credentials in source URLs or state. Credential-bearing HTTPS URLs are rejected; public HTTPS and local Git sources are supported.

Apply stages and retains backups in owned `.skilltree-storage-<destination-hash>` storage beside the destination, outside its catalog tree and on the same filesystem. Version 1 journal-owned transactions relocate intact through a restartable location journal before recovery. Completed legacy backups recognized by successful deployment reports can move intact with `migrate-storage`; unknown folders remain retained. `doctor` reports catalog-visible legacy data as errors and empty folders as warnings and nonempty unrecognized catalog folders as errors. Transactions cover one skill. No backup/history garbage collector is enabled.

New Linux collections use util-linux `flock` on a stable destination-keyed `sync.lock` under `~/.local/state/skilltree`, independent of `TMPDIR`. `--runtime-root` chooses an explicit coordinated domain; tests and demos keep it inside their own fixture. Git children inherit the lock descriptor, retaining exclusion if they outlive the parent. Kernel locks release on final descriptor closure. macOS and legacy collections use explicit stale-recovered directory locking; `setup --lock-backend mkdir|flock` chooses the backend. Stop older versions before upgrading locking domains. Runtime directory deletion while writers run invalidates coordination; platform lifetime still needs host verification. These locks coordinate Skilltree writers, not host applications. `configure` can upgrade mkdir to flock, but rejects flock-to-mkdir downgrade before changing the manifest. A collection left on mkdir by an older downgrade can explicitly restore flock with `configure --lock-backend flock`; this acquires the existing kernel domain and retains active kernel/directory writer guards. Do not delete the stable kernel lock inode to bypass those guards.

Use `init --adapter grok` for the isolated Grok filesystem preservation policy, which defaults ownership of root `workflow.md` and `runs.json`. Existing collections migrate with `configure --adapter grok`; plain filesystem collections can opt in with `configure --host-metadata`. An unsupported destination tree holds its affected skill rather than aborting other healthy selections. These regular files are excluded from skill hashes/capture and preserved through replacement and backups. Skill-authored reserved names remain rejected; unowned host directories are never adopted. Other host files or symlinks hold for explicit adapter reconciliation.

```sh
bun run dev -- doctor --home /absolute/collection
bun run dev -- recover --home /absolute/collection --dry-run
bun run dev -- recover --home /absolute/collection
bun run dev -- recover --home /absolute/collection --unlock
```

`doctor` is check-only. Interrupted transactions block other state writes until explicit recovery. Recovery either completes an already installed approved snapshot, restores retained previous bytes, or retains an unchanged destination. Unknown current bytes are held for manual reconciliation. `--unlock` removes a stale lock only after proving its process has exited; an unreadable owner or reused/live PID needs manual inspection. A crash before the lock owner record is written needs manual inspection too. Atomic records and recovery do not guarantee snapshot durability or prevent all external-write races; use coordinated destination access.

All state-writing commands have `--dry-run`. Dry capture/apply perform the same history preflights as real writes; dry sync checks the durable acquired source before fetching into scratch storage. Dry runs may acquire sources and merge files in isolated temporary storage, but do not alter manifests, approval records, sources, histories, reports, or library bytes. `status`, `list`, `inventory`, `verify`, and `doctor` are read-only.

## Source failures, events and restoration

Inventory reports supported skills alongside `holds` containing a source-relative `path`, `scope`, `code` and `message`. Invalid skill file sets and unsafe or unsupported projections remain excluded; healthy supported projections from the same repository remain selectable. Inventory exits nonzero with `PARTIAL` when healthy skills coexist with holds, or `ERROR` when none remain. Selecting a held path fails with its precise code and a path-bearing event. Invalid Claude skill declarations identify `skills[index]` without echoing declaration values; equivalent holds from overlapping scans appear once. An absent new selector reports `NOT_FOUND` unless a path-bearing hold covers it.

Sync isolates acquisition and source-root validation failures by source. Invalid selected skill content clears only its candidate, retaining accepted upstream/local history, historical approvals and deployed bytes. Healthy peers still stage. Unsupported manifests remain explicit projection holds; their semantics are never interpreted. Successful source observations and their skill candidates publish together in one atomic lock update; failed sources keep their prior source and skill records. Deployment remains per skill and requires explicit approval/apply. JSON reports expose path-bearing holds, named source errors and versioned `projection.held`, `skill.held`, `skill.conflict`, `skill.drift` and `source.error` events. CLI operation failures emit `operation.error`; integrations can consume these records without Skilltree sending messages. Unselected inventory holds remain visible in sync reports and events without failing an otherwise successful sync. A selected skill that cannot stage a candidate (including invalid content, removal, conflict or drift) or a failed source makes dry and real syncs exit nonzero. Results are `PARTIAL` when any source observation was successfully processed, otherwise `ERROR`; dry sync includes `dryRun: true` and retains the same no-authoritative-write guarantees. Candidates held only for exact approval remain successful staging results. A successful preview returns `DRY_RUN`. Single-source errors preserve their established error codes and identify the source.

Sources record observed fetched revisions; each skill records accepted reconciliation, local base, approval and deployment separately. A conflict can retain its older accepted skill revision while the source observation advances. That distinction never authorizes deployment.

New acquisition/capture operations archive accepted Git provenance before publishing its reference. Archive acquisition reads and verifies one Git object at a time; repository object bytes are not restricted by a single 10 MB subprocess response. Each Git object is bounded at 50,000,000 bytes and the metadata index at 10,000,000 bytes, with `ARCHIVE_LIMIT` on exhaustion. These archive bounds are separate from skill limits (10 MB per file, 50 MB total, 5,000 files). Use `archive` to migrate intact legacy state. `restore --dry-run` validates archives/provenance and existing work; `restore` materializes fresh generations offline and preserves old paths, approvals and deployed bytes. Missing generated files are recoverable; modified/staged/unknown work holds for reconciliation. Corrupt/missing archives hold without network fallback. This cannot recover unsnapshotted edits or prove a platform's real snapshot service.

```sh
bun run dev -- archive --home /absolute/collection
bun run dev -- restore --home /absolute/collection --dry-run
bun run dev -- restore --home /absolute/collection
```

## Whole-directory recovery

Every actual apply verifies a complete supported-directory recovery point before updating the library, including outside-lock skills and host-owned files. Its returned `recoveryPoint` is content-addressed and stored outside the catalog in `library-backups/`, with immutable `library-blobs/` payloads. Manifests bind directory entries, basic permissions, operator ownership, content and collection state. A failed or changed backup holds the update.

```sh
skilltree backup --home /absolute/collection --reason 'Before maintenance'
skilltree backups --home /absolute/collection
skilltree revert --home /absolute/collection --snapshot <id> --dry-run
skilltree revert --home /absolute/collection --snapshot <id> --expect <reviewed-current-hash> --quiet-host
```

Revert previews added, removed and changed paths, requires the reviewed current hash, and verifies a new current-state recovery point before restoring. It stages outside the catalog and journals the directory swap. `recover` completes recognized interrupted swaps or rolls back the preserved prior directory; newer unknown bytes hold. Latest source/local histories remain retained, while restored deployment baselines are held and approval/candidates cleared. Uncaptured drift stays drift. This can affect outside-lock data, so authorize the whole diff explicitly.

`restore` remains archive materialization for generated Git caches; installer `--restore` rebuilds a runner. Whole-directory `revert` is distinct. Recovery points are retained indefinitely; `compact --retain-backups` never removes them. There is no recovery-point deletion policy installed.

Support covers ordinary same-owner Unix files/directories and resolvable relative in-tree links, basic modes, up to 25,000 entries/200 MB/10 MB per file. Special files/permissions, hardlinks, owner changes, ACLs and unsupported xattrs hold. Linux requires Python 3 with standard-library xattr APIs; macOS uses built-in xattr/ls. macOS-managed provenance and timestamps are not portable restored metadata. Host concurrency, actual Computer Update and power-loss durability remain separate evidence; no unconditional recovery guarantee is made. See the bundled [skill](skills/skilltree/SKILL.md) and [Gardener profile](agents/gardener.md).

## Configuration and explicit maintenance

Resolve and verify destination aliases with `realpath` before initialization; Skilltree requires the canonical path and does not bypass symlink checks. `--storage` chooses a writable transaction root outside state and the catalog, on the same filesystem. The Grok adapter here implements filesystem preservation; sanctioned catalog refresh, host writers and Computer Update remain separate host integration contracts.

```sh
bun run dev -- configure --home /absolute/collection --adapter grok --dry-run
bun run dev -- configure --home /absolute/collection --adapter grok
bun run dev -- migrate-storage --home /absolute/collection --dry-run
bun run dev -- migrate-storage --home /absolute/collection
bun run dev -- compact --home /absolute/collection --retain-backups 2 --caches --scratch --dry-run
```

Actual compaction requires the same explicit policy without `--dry-run`. It retains the latest requested count of verified backups, preserves changed/unknown backups, and reclaims proven inactive generated cache files backed by validated archives. Git packing under `--caches` preserves the complete object set and refs. Older cache objects can be reclaimed after archive comparison while unproven refs/configuration/logs remain. Immutable archives and approval history are never garbage-collected. Unique history and unknown work can still grow; no global disk cap is promised. This command is not scheduled automatically and no real-user retention policy is installed.

Stale scratch cleanup requires a proven exited owner and matching file records. Unknown/partial scratch material holds. Runtime migration records and holds the prior lock domain; stop older writers before migration. Older schemas reject upgraded manifests, and compatible kernel writers contend on the preserved previous inode. Unsupported directory/kernel mixing holds rather than stealing a lock.

`doctor` suggests `restore --dry-run` when the corresponding archive validates. Source errors distinguish network, authentication, reference, unavailable repository, timeout, I/O and validation causes without echoing raw diagnostics or credentials.

## Source adapters

Native inventory supports `.agents/skills`, `.claude/skills`, `skills/`, and local paths declared by `.claude-plugin/plugin.json`. Competing same-name projections remain separate; inventory identifies byte-equivalent copies and ambiguity, and selection always names an exact path. No traversal-order union or runtime-plugin compatibility is implied.

Cursor/Codex/ChatGPT manifests and marketplaces are held explicitly as unsupported projections until adapters are verified. Their presence does not block conventional supported skill folders. Symlinks, special files, nested repositories, `node_modules`, legacy `workflow.md`, and `runs.json` are rejected inside skill file sets. Empty directories, ownership, ACLs, and directory permissions are not content; deployed files normalize to 0644 or 0755. Selected skill removal is held; file rename is delete/add. External dependency declarations and missing/outside inline Markdown references are rejected. Arbitrary script imports and all runtime dependencies cannot be statically proven; review remains necessary.

The optional replaceable probe invokes pinned [`skills@1.7.2`](https://github.com/vercel-labs/skills/blob/main/package.json) with listing only, in isolated scratch/cache directories:

```sh
bun run dev -- probe upstream --home /absolute/collection
```

It requires Node >=22.20 and `npx`; `--npx <executable>` can select a working launcher. This boundary does not assume a stable SDK, does not parse Cursor manifests because Cursor is an install target, and never uses the upstream installer over live edited content. npm 10's npx was verified; the ambient npm 11 launcher on the development host failed to start and can be replaced through this option. Normal Skilltree operations do not require the upstream CLI.

## Builds and local package runners

```sh
bun run build
node dist/cli.mjs --help
bun run build:compile
./dist/bin/skilltree-darwin-arm64 --help  # example native target
node bin/skilltree.mjs --help
npm pack --ignore-scripts
npx --yes --package ./outfitter-skilltree-0.1.0-rc.1.tgz skilltree --help
bunx --package ./outfitter-skilltree-0.1.0-rc.1.tgz skilltree --help
```

The Node launcher selects a prepared matching native binary when present, otherwise the bundled Node CLI. The npm tarball includes only the portable Node bundle; native binaries remain optional checkout/standalone artifacts. Build the portable bundle before staging a package. Build artifacts are disposable; `--home` always supplies durable state. Git remains an external prerequisite. The accepted local milestone was verified on Node 20.19.2/macOS arm64. The separate assessment workflow tests Linux x64 portable/native execution and isolated runner restore. These are compatibility fixtures; no Grok host or universal runtime guarantee is made. The initial candidate is published; registry availability of later versions must be verified before advertising them. Direct source-checkout publication is blocked in favor of the reviewed release workflow. See [package releases](docs/releases.md).

A standalone local install needs an approved portable artifact, its SHA256 and an explicit supported Node executable. It downloads nothing and installs no service or hook:

```sh
node bin/install.mjs --prefix /absolute/runner --state-home /absolute/collection --artifact /absolute/approved-cli.mjs --sha256 <reviewed-sha256> --node /absolute/node
/absolute/runner/bin/skilltree --help
node bin/install.mjs --prefix /absolute/runner --state-home /absolute/collection --restore
```

With `--state-home`, the receipt and verified artifact live in separate durable state, so loss of the entire runner prefix can be restored. Legacy prefix-local receipts remain supported but cannot survive prefix loss. The installer validates every planned destination before any write; `dist/` is derived. Restoration refuses unknown changed bytes. A missing build or runner exits nonzero.

## Development and scope

`bun run check` runs lint, formatting, strict type checks, unit/integration tests, and portable build. `bun run demo` creates and retains an isolated Git source, installs a selected skill, captures local drift, stages an upstream update, approves/applies it, and proves both edits survived. No live skill library is touched.

Keep domain, content, Git, inventory, state, and deployment boundaries separate. Skillset integration remains deferred. See [AGENTS.md](AGENTS.md), [the implementation acceptance plan](docs/implementation-plan.md), and proposed [Grok setup](docs/grok-bot/setup.md), [environment](docs/grok-bot/environment.md), and [bot profile](docs/grok-bot/bot-profile.md). The Grok references do not establish a working destination adapter. [Architecture and gaps](docs/grok-bot/architecture-and-gaps.md) explains the branch/merge model, lock and catalog differences, and the next isolated integration slice. `bun run demo:restore` checks actual archive materialization after simulated directory exclusions and standalone runner restoration, without installing a live hook.

Licensed under the [MIT License](LICENSE).

For a new checkout, `bun run setup` validates the pinned runtime and checkout-local `CLAUDE.md -> AGENTS.md`, installs frozen dependencies without lifecycle scripts, and runs checks. Configure Orca's setup command as `bash scripts/bootstrap.sh`, wait for successful setup before agent startup, and leave archive empty.

For an interrupted revert that finds newer supported current data, an explicitly authorized keep-current recovery is available:

```sh
skilltree recover --home /absolute/state --keep-current --dry-run
skilltree recover --home /absolute/state --keep-current --expect <reviewed-current-hash> --quiet-host
```

It verifies a new recovery point before canceling the interrupted restore, keeps current directory bytes and retained prior data, and leaves ownership drift for explicit reconciliation. It does not overwrite newer edits. Repeated completed reverts with unchanged directory and ownership state return CURRENT.

### Recovery prerequisites and explicit copy cleanup

On Linux, direct metadata inspection is embedded in both runner builds and uses Python 3's standard-library `os.listxattr`/`os.getxattr`, including POSIX ACL xattrs. `getfattr`/`getfacl` are not required. `doctor` nonmutatingly checks the complete directory and names unsupported/unreadable paths or missing Python capability. Missing dependencies require explicit approved durable provision; the runner never installs them. Linux mount IDs distinguish real nested/bind mounts while allowing overlayfs file/directory `st_dev` differences.

Actual whole-directory revert/recovery requires `--quiet-host` after the caller stops catalog pickup and other writers for the complete interval. The directory temporarily disappears during rename; this flag is a caller attestation, not host control or concurrent safety. An unexpected recreated directory holds with all prior data retained. Linux timestamps are not restored; timestamp-driven host behavior remains unverified. Unsupported entries anywhere in the library intentionally block the complete backup; doctor reports their paths. They must be reconciled explicitly, never silently excluded.

```sh
skilltree compact --home /absolute/state --retained-directories --dry-run
skilltree compact --home /absolute/state --retained-directories
skilltree compact --home /absolute/state --backup-scratch --dry-run
skilltree compact --home /absolute/state --backup-scratch
```

These separate opt-in policies clean verified receipt-owned stage/prior copies and complete checkpointed temporary blobs with exited owners. They preserve every whole-directory recovery point and blob. Unowned legacy copies, newer notes, corrupt/partial temps and live-owner material hold. No automatic cleanup runs.

The default Linux lock path uses the OS account's passwd home, independent of `$HOME`; fixture/custom placement requires `--runtime-root`. Runner upgrades use a new approved content-specific installer prefix and the exact artifact SHA256; verify it before selecting its launcher. Old prefixes/receipts remain intact. Runner restore does not restore Python or other OS dependencies.

### Runner identity and final recovery diagnostics

`skilltree --version` needs no state and reports package version, Git revision/dirty status and a SHA256 of runtime source/dependency inputs. Portable and native builds embed this identity at build time; exported source without Git still has its source hash. Verify the approved revision/hash when selecting a new immutable runner prefix. This identity is not a safety guarantee.

Linux metadata inspection resolves the system `/usr/bin/python3` to an absolute regular interpreter, requires root ownership without group/world write permission, and pins its identity during the process. PATH cannot select an alternate inspector. Doctor reports its path, version and binary SHA256; a missing or changed interpreter holds. OS dependency trust/provision remains separate from runner restoration.

Before creating a disposable intent marker or blob temp, Skilltree fsyncs a checksummed reservation in the permanent `library-scratch.jsonl` metadata journal. A complete payload intent is then fsynced before blob creation; inode ownership is checkpointed before payload writes. Explicit backup-scratch cleanup can remove reserved empty artifacts or prove interrupted payload prefixes after the writer exits. Different bytes, unowned artifacts and incomplete nonempty intent remain held. Doctor exposes candidates and held scratch with paths/reasons without mutation. Interrupted journal initialization or a partial journal tail blocks new scratch allocation until explicit reviewed recovery. `recover --scratch --dry-run` reports the expected journal hash; actual `recover --scratch --expect <hash>` seals the exact original bytes, carries forward unresolved ownership and opens a fresh active journal. It acquires the collection lock, refuses recognized active owners and preserves unknown artifacts. No automatic truncation occurs. The active payload-free journal has a 64 MB cap; doctor warns before exhaustion, and complete-cycle capacity is checked before reservation. The same reviewed recovery provides capacity rollover. Temporary payload intents remain bounded and complete recovery points stay intact. Timed tests are samples, not a zero-artifact or power-loss guarantee.

Backup cause codes distinguish `BACKUP_LIMIT`, `BACKUP_MOUNT`, `BACKUP_PERMISSIONS`, `BACKUP_OWNER` and `BACKUP_HARDLINK`; messages identify the path. Unsupported links/metadata retain their existing unsupported category. Recovery previews never finalize receipts or mutate durable state.

Rootless Linux user namespaces may show the system interpreter's unmapped root owner as UID 65534. The strict root-owned Python trust check correctly fails in that namespace; it is not relaxed and no alternate interpreter configuration is provided. Use the supported ownership-preserving environment. This limitation does not affect the verified Grok host shape.

### Reviewed scratch journal recovery

```sh
skilltree recover --home /absolute/state --scratch --dry-run
skilltree recover --home /absolute/state --scratch --expect <reviewed-journal-hash>
```

Remove an OS file-size limit or resolve disk/quota exhaustion before retrying recovery. `STORAGE_EFBIG`, `STORAGE_ENOSPC` and `STORAGE_EDQUOT` name the affected write path and preserve partial bytes. A partial created-row checkpoint can follow an already-created empty blob; it does not mean no scratch exists. Reviewed sealing retains the original journal under `library-scratch-seals`, copies valid unresolved ownership into the active replacement and leaves unproven files untouched. Sealed evidence is a warning; physical unowned or changed scratch remains held. A pending repair blocks other writes and can resume with `recover --scratch`; newer unknown replacement bytes hold. Seal storage can grow and is not automatically deleted. Doctor also reports retained revert stage/prior directories without matching receipts.
