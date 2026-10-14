# @outfitter/skilltree

## 0.1.0-rc.2

### Patch Changes

- 1fd7f87: Use a Changesets v3-compatible version action so subsequent release candidates can read retained prerelease changesets and prepare reviewed version PRs.
- e526ffe: Add compatible skill selection, plan/apply and snapshot commands while preserving explicit hash approval, full-library backups, local edits and guarded recovery.

## 0.1.0-rc.1

### Patch Changes

- 3a20f1a: Recognize Changesets prerelease PR titles and run automatic read-only checks for the exact generated version PR head.
- f0f61ce: Isolate invalid skills and unsupported source projections with explicit path-bearing holds so healthy skills remain selectable and stageable. Preserve accepted skill histories and local edits, report selected-skill and source failures with nonzero dry-sync exits while retaining unselected holds as diagnostics, deduplicate overlapping discovery holds and identify invalid declarations, and validate supported multi-megabyte files without exhausting the Node regexp stack.
- cd6c128: Prepare the portable Unix CLI npm package and policy-gated release automation. Runtime behavior and deferred recovery follow-ups are unchanged.
- 1f40103: Tighten release intent and publication checks for every shipped payload and install lifecycle hook.

## 0.1.0-rc.0

Initial reviewed release candidate for Git-backed skill synchronization, explicit content approval, local-edit preservation, and isolated backup/recovery workflows. Publication and live host integration must be verified separately.
