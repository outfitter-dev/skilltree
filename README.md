# Skilltree

Skilltree synchronizes selected skills from Git repositories into one shared library while retaining local edits and approving exact content snapshots.

## Status

`0.1.0-rc.0` is a local release candidate, not a published npm release. The filesystem workflow is implemented and tested in isolated fixtures. Live Grok deployment, host catalog pickup, and Cursor/ChatGPT plugin ingestion remain unverified or unsupported.

The CLI provides Git acquisition, normalized inventory, explicit selection, shared profile assignments, local-edit capture, three-way reconciliation, staging, exact-hash approval, apply, verification, diagnostics, and interrupted-replacement recovery. `sync` stages only; it never grants approval or deploys automatically.

## Getting started

Use Git and Bun 1.4.2 for source development. Run the CLI against a directory whose writes you coordinate; the filesystem adapter does not lock out a host application.

```sh
bun install --frozen-lockfile
bun run check
bun run dev -- --help
```

Choose durable state and destination paths separately from the source checkout and disposable runner. Paths must be canonical and free of symlink components. Sources must be committed Git repositories.

```sh
bun run dev -- init --home /absolute/collection --dest /absolute/shared-skills --exclusive-dest
bun run dev -- add owner/repo --home /absolute/collection --source upstream --ref main
bun run dev -- inventory upstream --home /absolute/collection
bun run dev -- select upstream --home /absolute/collection --path .agents/skills/example --id example --profile gardener --install --reason 'User requested this specific installation'
bun run dev -- list --home /absolute/collection --profile gardener
bun run dev -- verify --home /absolute/collection
```

`select --install` records the specific installation request against the complete selected snapshot and applies it without a redundant approval command. It assumes an authorized operator: automated callers must have the corresponding user authorization. Registration with `add` or discovery alone never supplies installation approval. Without `--install`, selection is held for review.

## Updates and local edits

The library is shared; profile filtering is metadata, not access isolation. Optional `--gardener` and `--primary` on `init` record configurable profile metadata. No agents, messages, routines, or integrations are started.

When an owned deployed skill has local edits, `verify` reports drift. Explicitly adopt those edits with `capture` before syncing. Capture clears the candidate; sync must reconcile and restage before approval:

```sh
bun run dev -- capture example --home /absolute/collection
bun run dev -- sync --home /absolute/collection --dry-run
bun run dev -- sync --home /absolute/collection
bun run dev -- status --home /absolute/collection
```

Review the `candidate.hash`, complete content object, reasons, and local/upstream changes in the JSON status and durable objects. Then name that exact hash:

```sh
bun run dev -- approve example --home /absolute/collection --hash <candidate-hash> --reason 'Reviewed the complete content and dependencies'
bun run dev -- apply example --home /absolute/collection --hash <candidate-hash>
```

Hashes include every skill file's path, bytes, and executable bit. Changing a supporting script changes approval scope. Git three-way file merges retain nonconflicting local changes; conflicting or removed selected skills are held. A changed candidate cannot use a stale approval. Manual policy is the only unattended-update policy in this candidate; authority never expands automatically.

Triage flags changed scripts and potentially sensitive instructions. It prioritizes review and cannot establish safety. Skilltree never executes a source skill's scripts, and approval to install does not authorize every action in the skill.

## Durable state and recovery

- `skilltree.json`: immutable destination, adapter, gardener/primary metadata, manual policy.
- `skilltree.lock`: selections and profiles; distinct upstream, local base/hash/Git commit, candidate, approval, observed local baseline, and last deployment records.
- `objects/`: immutable complete file snapshots, checked against their SHA-256 on use.
- `repos/`: acquired Git sources; do not treat them as local edit workspaces.
- `edits/`: local Git histories. `capture` records local library edits here; dirty history checkouts are preserved and block capture/apply rather than being cleared.
- `reports/`: per-write JSON receipts with run IDs.
- `transaction.json`: interrupted per-skill replacement journal, when present.

Keep the entire state directory, including objects and local history, backed up. Manifest/lock files alone cannot recover local patches. Do not store credentials in source URLs or state. Credential-bearing HTTPS URLs are rejected; public HTTPS and local Git sources are supported.

Apply stages beside the destination, retains previous nonempty directories under `.skilltree-transaction-*`, and rechecks live hashes before and after replacement. Transactions cover one skill, not the whole collection. Backups are retained; there is no automatic cleanup. A runtime directory lock keyed by destination lives under the OS temporary directory, outside durable state. It serializes Skilltree writers, not host writes.

```sh
bun run dev -- doctor --home /absolute/collection
bun run dev -- recover --home /absolute/collection --dry-run
bun run dev -- recover --home /absolute/collection
bun run dev -- recover --home /absolute/collection --unlock
```

`doctor` is check-only. Interrupted transactions block other state writes until explicit recovery. Recovery either completes an already installed approved snapshot, restores retained previous bytes, or retains an unchanged destination. Unknown current bytes are held for manual reconciliation. `--unlock` removes a stale lock only after proving its process has exited; an unreadable owner or reused/live PID needs manual inspection. A crash before the lock owner record is written needs manual inspection too. Atomic records and recovery do not guarantee snapshot durability or prevent all external-write races; use coordinated destination access.

All state-writing commands have `--dry-run`. Dry runs may acquire sources and merge files in isolated temporary storage, but do not alter manifests, approval records, sources, histories, reports, or library bytes. `status`, `list`, `inventory`, `verify`, and `doctor` are read-only.

## Source adapters

Native inventory supports `.agents/skills`, `.claude/skills`, `skills/`, and local paths declared by `.claude-plugin/plugin.json`. Competing same-name projections remain separate; inventory identifies byte-equivalent copies and ambiguity, and selection always names an exact path. No traversal-order union or runtime-plugin compatibility is implied.

Cursor/ChatGPT manifests and marketplaces fail explicitly until adapters are verified. Symlinks, special files, nested repositories, `node_modules`, legacy `workflow.md`, and `runs.json` are rejected inside skill file sets. Empty directories, ownership, ACLs, and directory permissions are not content; deployed files normalize to 0644 or 0755. Selected skill removal is held; file rename is delete/add. External dependency declarations and missing/outside inline Markdown references are rejected. Arbitrary script imports and all runtime dependencies cannot be statically proven; review remains necessary.

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
npx --yes --package ./outfitter-skilltree-0.1.0-rc.0.tgz skilltree --help
bunx --package ./outfitter-skilltree-0.1.0-rc.0.tgz skilltree --help
```

The Node launcher selects a prepared matching native binary when present, otherwise the bundled Node CLI. Rebuild both before packing; compiled files are platform-specific. Build artifacts are disposable; `--home` always supplies durable state. Git remains an external prerequisite. The portable workflow and launcher are verified on Node 20.19.2/macOS arm64; native execution is verified only on macOS arm64. No Linux/Grok or universal runtime guarantee is made. The package stays private to prevent accidental publication.

## Development and scope

`bun run check` runs lint, formatting, strict type checks, unit/integration tests, and portable build. `bun run demo` creates and retains an isolated Git source, installs a selected skill, captures local drift, stages an upstream update, approves/applies it, and proves both edits survived. No live skill library is touched.

Keep domain, content, Git, inventory, state, and deployment boundaries separate. Skillset integration remains deferred. See [AGENTS.md](AGENTS.md), [the implementation acceptance plan](docs/implementation-plan.md), and proposed [Grok setup](docs/grok-bot/setup.md), [environment](docs/grok-bot/environment.md), and [bot profile](docs/grok-bot/bot-profile.md). The Grok references do not establish a working destination adapter.

Licensed under the [MIT License](LICENSE).

For a new checkout, `bun run setup` validates the pinned runtime and checkout-local `CLAUDE.md -> AGENTS.md`, installs frozen dependencies without lifecycle scripts, and runs checks. Configure Orca's setup command as `bash scripts/bootstrap.sh`, wait for successful setup before agent startup, and leave archive empty.
