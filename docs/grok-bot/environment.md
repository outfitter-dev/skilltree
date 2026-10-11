# Grok Bot environment

Status: reference notes, not implemented behavior. Requirements for a Grok Bot destination adapter, based on what was observed on a live Grok Bot computer on 2026-10-11. Each item is labeled **verified**, **observed** or **unknown**. None of this is implemented in skilltree yet. Paths are Grok Bot platform defaults, not anyone's personal setup.

## Skill library

- **verified:** The shared skill library is `/home/box/agent-data/workflows`, which resolves to `/home/box/sand-data/workflows`. Each skill is a folder with a `SKILL.md` (YAML frontmatter with `name` and `description`, then a markdown body). Folders can also hold extra files and subfolders.
- **verified:** The host app reads and writes this folder too. It creates, updates and deletes skill folders, and it migrates a legacy `workflow.md` to `SKILL.md`.
- **verified:** The host treats `SKILL.md`, `workflow.md` and `runs.json` as reserved filenames inside a skill folder, and leaves them out when it lists or publishes a skill's extra files. `runs.json` is the host's routine run-log filename. The copies observed were under each agent's automations folder, not under workflows.
- **unknown:** Whether the host ever writes other files inside workflows.
- **Requirements:**
  - Touch only the folders recorded in skilltree's lock, each tracked by content hash.
  - Never delete or overwrite a folder the lock doesn't record.
  - Never ship a reserved filename as an extra file.
  - On drift, report it rather than overwriting.
  - Write atomically: build each skill in a temporary sibling folder, then rename it into place.

## Discovery and reload

- **observed:** Each bot gets a catalog of skills (path plus description) in its context. The catalog refreshes when that bot's conversation is summarized, so a newly added skill may not appear right away.
- **observed:** A bot can read any `SKILL.md` by path at any time, and file changes are visible on disk immediately.
- **unknown:** Whether the host's own skill-write path and a direct file edit differ in how the catalog picks up a change.

## Persistence across a Computer Update

- **verified:** An update rebuilds the system image and rehydrates a durable store. These always survive:
  - `/workspace`
  - `/home/box/sand-data`, which includes the skill library
  - the browser profile
- **verified:** Most of `/home/box` also survives, but only while a backend whole-home flag is on.
- **verified:** The whole-home copy skips these folders: `.cache/`, `.npm/`, `.nvm/`, `.rustup/`, `.local/state/`.
- **verified:** `/workspace` sync skips these folders: `node_modules/`, `.venv/`, `venv/`, `dist/`, `build/`, `target/`, `.cache/`, `__pycache__/`.
- **verified:** An update replaces system paths (`/usr`, `/usr/local`, `/etc`, `/opt`) with the image's copies, wipes `/tmp` and `/run`, and drops agent apt installs and running processes. Image-provided tools come back; anything an agent added there does not.
- **verified:** The store syncs about every 2 minutes. Changes made in the last couple of minutes before an update can be lost.
- **Requirements:**
  - Keep the manifest, lock, source clones and reports under `/workspace/skilltree/`, with clones in `repos/`. Avoid the folder names that sync skips.
  - Target the image's Node 20 floor, or ship a standalone binary (`bun build --compile`). A runner at `~/.local/bin/skilltree` is a convenience, not the durable source of truth.
  - `skilltree doctor` checks the runtime, paths, write access and lock, and reports anything missing.

## Runtime

- **verified:** `git` 2.47.3 is part of the image (`/usr/bin/git`).
- **verified:** Node v20.19.2 is part of the image (Debian package).
- **observed:** Bun 1.4.2 is present as an image-provided, root-owned shim at `/usr/local/bin/bun`. Its version can change with the image, so don't depend on a pinned Bun at runtime.
- **verified:** `flock` is available.
- **verified:** There is no cron and no systemd (PID 1 is tini).

## Scheduling and locking

- **verified:** Scheduled runs have to come from a Grok Bot routine that runs `skilltree sync` through its shell tool. Routines are scheduled server-side and survive updates. A background shell loop dies on every restart.
- **observed:** The routine shell starts in `/workspace`, and its working directory persists within a session, so the routine should `cd` explicitly. `~/.local/bin` is first on PATH. A foreground call waits about 30 s by default, and longer work can run in the background.
- **unknown:** The hard timeout for a routine run, and whether two firings of one routine can overlap.
- **Requirements:**
  - Run lock: `flock -n ~/.local/state/skilltree/sync.lock`. A second run exits with LOCKED. That folder isn't synced or restored, so a snapshot restore can't bring back a stale lock. Never put the lock in `/workspace` or sand-data.
  - The routine reports when the binary is missing.

## Notify (proposed)

- After a run that results in UPDATED, CONFLICT, HELD or ERROR, send one event. Targets: a webhook (for example, a Grok Bot routine's webhook trigger), a local command, or a report file. Include a run id for dedup. A clean run sends nothing.
- A "Skill Gardener" bot profile could subscribe to these events, review held skills and resolve conflicts.
