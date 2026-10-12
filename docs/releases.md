# Package releases

Skilltree follows the Changesets version-PR and policy-gated npm workflow used by Skillset and Trails. The initial candidate remains `@outfitter/skilltree@0.1.0-rc.0`; public publication is not established by a successful local tarball test.

## Package contract

The public tarball contains the portable Node CLI, launcher, standalone installer, license, changelog, documentation and bundled skill/agent guidance. Runtime libraries are bundled; installing the package requires no runtime dependency download or lifecycle hook. Native compiled binaries remain optional local artifacts and are excluded from npm, so the package does not depend on the machine that packed it. Supported operating systems are macOS and Linux, with Node >=20; Git and the documented filesystem/locking prerequisites remain external. Distribution checks cover Node20 portable execution and isolated library workflows without live host writes.

## Reviewed versions

Package-facing source, package metadata, build-input or README changes carry a branch-owned `.changeset/*.md`. `bun run changeset` records release intent. The repository starts in Changesets `rc` prerelease mode; use `bun run changeset pre exit` in an explicitly reviewed stabilization branch when ready for a stable version.

On main, `release.yml` creates or updates `changeset-release/main`, titled `chore(release): version packages`. This PR owns generated versions and changelog updates. A maintainer reviews it and verifies the exact PR-head and main commit `linux-node20` checks before release. Keep generated version PRs unmerged while those checks are missing or blocked. GitHub-token-created PR workflow runs may require a collaborator to approve/request them; a manual diagnostic run does not replace a PR-associated required check. Unattended bot CI would require a separately approved GitHub App credential; none is provisioned here.

The workflow preserves existing human label families. Otherwise it defaults to `publish:manual` and labels the channel and version delta. Stable source PRs carrying explicit `stack:boundary` evidence can qualify for `publish:auto`. Automatic publication additionally verifies repository/main context, the generated bot version PR and squash-commit identities, a version-only diff, unchanged manifest fields apart from version, changelog/version intent and exact source/PR-head CI. Ambiguous or prerelease versions stay manual. Unknown/conflicting labels and `publish:block` stop release; `publish:none` requires a `release-reason:` audit note.

Use squash merge with the generated release title to meet the automatic commit-identity gate. No ordinary code push publishes just because a version is present. If main has moved beyond an unpublished version commit, rerun that version commit's original workflow rather than rebuilding the old version from newer source.

## Publication and immutable verification

Stable qualified releases use the existing `npm-auto` GitHub environment. Manual releases require an explicit `Release` workflow dispatch with its `publish` input enabled and approval through the existing protected `npm` environment. Both environments must already exist and permit only the `main` branch. `npm` requires a release reviewer; `npm-auto` relies on the reviewed-version policy instead of an additional reviewer gate. The policy checks these settings before the publish job can start. It does not create an environment or modify protections.

The publisher builds a clean exact source commit, stages one tarball, records SHA256/SHA512 integrity and embedded source identity, cold-installs the staged bytes, rechecks policy at publication time, then uses npm 11.18.0 on Node24 with OIDC and provenance. No `NPM_TOKEN` is configured. It verifies immutable registry integrity, the intended dist-tag and provenance before a separate fresh-cache Node20 registry install runs the isolated CLI workflow. Only then does it create `v<version>` and the GitHub release. Existing mismatched tags, versions or assets hold; no force push or asset clobber is used.

If a publish or propagation check fails, publication may already have succeeded. Inspect registry state and rerun the original reviewed workflow. Exact occupied bytes are verified and skipped; different immutable bytes stop. Existing release assets must match the staged tarball. The workflow never silently moves a dist-tag to repair drift. `rc` candidates use the `rc` dist-tag and are not promoted to `latest`.

## Initial package bootstrap and required access

A first trusted-publisher setup requires an npm package identity. The initial candidate therefore has a bounded bootstrap path using an existing authorized npm account, before merging a later generated version PR. Run this only after the release-setup PR is reviewed and merged, from clean `main` matching live `origin/main`, with its exact CI green:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run release:stage -- --dir /new/reviewed/stage
bun run release:smoke -- /new/reviewed/stage
bun run release:bootstrap -- --dir /new/reviewed/stage --confirm-version 0.1.0-rc.0 --expect-sha256 <reviewed-tarball-sha256>
```

The bootstrap refuses other versions, branches, dirty or stale source, changed staged bytes, missing exact-main CI and unauthenticated npm. It publishes only the confirmed tarball to `rc`, using the existing account's normal npm authorization/2FA. It creates no account, token, login configuration or publisher connection. A local bootstrap does not claim CI provenance; all subsequent workflow releases require it. Direct `npm publish` from the checkout is blocked; the checked publisher submits a reviewed tarball with lifecycle scripts disabled.

These persistent access changes need separate action-time approval and are not performed by this PR:

- For `outfitter-dev/skilltree`, create/configure GitHub environment `npm` with a designated release reviewer and a selected branch rule allowing only `main`.
- Create/configure `npm-auto` with only the `main` branch allowed and no additional required reviewer. Review the release policy before enabling this automatic path.
- After initial package registration, add the npm trusted publisher for `@outfitter/skilltree`: GitHub organization `outfitter-dev`, repository `skilltree`, workflow filename `release.yml`, environment field blank (the workflow controls the two environment paths), allowed action `npm publish`. Standalone dist-tag management is unnecessary.
- If current npm authentication is unavailable, authorize an account/session with publish permission in the existing `@outfitter` scope. Credential/session provisioning is a separate approved action; scripts do not perform it.

Use [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) for the provider setup. The workflow filename and repository must match exactly. Package access and npm authentication are not proven by GitHub organization membership.
