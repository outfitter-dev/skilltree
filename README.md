# Skilltree

Skilltree is a proposed Git-backed skill synchronization CLI that preserves local edits while tracking upstream changes.

## Status

This repository is an initial Bun/TypeScript scaffold. The CLI prints help and rejects unsupported commands. It does not discover, install, sync, approve, or deploy skills. No npm package or compiled distribution is available from this scaffold.

## Proposed direction

- Source adapters and explicit selection of skills and supporting files.
- Git history for upstream revisions and local edits.
- A manifest plus content-addressed approval and deployment records.
- Drift detection, staged deployment, and recoverable reconciliation.
- One shared skill library with optional profile metadata; filtering does not provide access isolation.

An explicit user request to install a specific skill supplies approval within the requested scope. Autonomous discovery and later updates require an explicit user-authorized policy. Safety triage helps prioritize review; it cannot guarantee safety. Integration with a primary agent should be optional and configurable.

Skillset integration is deferred. Plugin ingestion does not imply that every plugin runtime feature will work in a destination environment. These are design goals, not implemented behavior.

The proposed package name is `@outfitter/skilltree`. Compiled distribution through `npx` or `bunx` remains a future packaging decision, subject to platform testing.

## Development

Use Bun 1.4.2, pinned in `.bun-version` and `package.json`.

```sh
bun install --frozen-lockfile
bun run dev -- --help
bun run check
```

`check` runs lint, formatting validation, strict TypeScript checks, CLI smoke tests, and a Bun-targeted build. The build writes `dist/cli.js`; it is not a standalone executable.

```sh
bun dist/cli.js --help
bun run format:fix
```

Source lives in `src/` and tests in `tests/`. Keep modules focused as behavior develops; introduce workspaces only when independent package boundaries justify them. There are no dependencies on neighboring checkouts.

See [AGENTS.md](AGENTS.md) for contributor guidance. License selection is pending; this repository does not yet include a license grant.
