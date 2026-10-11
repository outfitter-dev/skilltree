# Contributor guidance

Skilltree is a development scaffold for a proposed Git-backed skill sync CLI. Read the README before changing scope or making product claims.

## Commands

```sh
bun install --frozen-lockfile
bun run dev -- --help
bun run check
bun run format:fix
```

`check` runs lint, formatting, typecheck, tests, and build. Keep the Bun pin in `.bun-version`, `packageManager`, and `engines` aligned when intentionally upgrading. Commit `bun.lock` with dependency changes.

## Implementation

- Keep CLI argument handling separate from future domain logic and source/deployment adapters as those modules emerge.
- Use strict TypeScript and focused `bun:test` coverage for behavior, failure paths, and preservation guarantees. Typecheck tests as well as source.
- Prefer small modules and explicit boundaries. Do not copy neighboring repository internals or add cross-checkout dependencies.
- Keep documentation accurate about implemented behavior; proposed commands and runtime guarantees require evidence before being advertised.
- Use Conventional Commits and inspect the staged diff before committing.

## Future sync constraints

- Preserve local edits and unknown or unowned destination files. Never deploy through broad directory cleanup.
- Approval should bind to the complete resolved content, including scripts and dependencies. An explicit request to install a specific skill counts as approval within that scope; autonomous updates need explicit policy.
- Safety triage is not a guarantee of safety or unlimited permission for a consuming agent.
- Keep primary-agent integration optional and configurable. Profile metadata must not imply access isolation.
- Prove drift detection, staging, recovery, and source-format handling before claiming those features work. Skillset integration remains deferred.

## Public repository boundaries

Keep private planning notes, personal identities, machine paths, credentials, environment audits, and coordination transcripts out of tracked files. Review new files and dependency metadata before public pushes.

Do not publish packages, configure credentials, alter organization access/security, or add release/deployment workflows without explicit authorization. License selection is pending; do not choose one by assumption.

`AGENTS.md` is canonical; keep `CLAUDE.md` as a symlink to it.
