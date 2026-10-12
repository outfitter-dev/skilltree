import { compactLibrary } from "./library-maintenance";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { manifestSchema, fail } from "./model";
import {
  assertNoSymlinks,
  atomicJson,
  readJson,
  exists,
  inside,
  getObject,
  liveHash,
} from "./files";
import { runtimePath, type Context } from "./state";
import { expectedLive, storage, storageRoot, targetPath } from "./deployment";
import { sourcePath, localPath, git, gitBytes, gitObjects, preflightSource } from "./git";
import { readArchive } from "./archives";
import {
  ownershipSchema,
  validateOwned,
  removeOwned,
  rememberBackup,
  type Ownership,
  inventory,
  materializationRecord,
  rememberMaterialization,
} from "./ownership";
import type { Options } from "./service";

export function sourceFailure(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; stderr?: unknown; message?: unknown };
  if (e.code === "ETIMEDOUT") return "SOURCE_TIMEOUT";
  if (["ENOBUFS", "ARCHIVE_LIMIT"].includes(String(e.code))) return "SOURCE_LIMIT";
  if (e.code === "ENOENT") return "SOURCE_TOOL_OR_PATH_MISSING";
  if (["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(String(e.code))) return "SOURCE_IO";
  const diagnostic = String(e.stderr ?? "");
  if (
    /authentication|permission denied|403|401|credentials|username|prompts disabled/i.test(
      diagnostic,
    )
  )
    return "SOURCE_AUTH";
  if (/resolve host|connect|network|ssl|tls|timed out/i.test(diagnostic)) return "SOURCE_NETWORK";
  if (/remote ref|invalid ref|not a valid object/i.test(diagnostic)) return "SOURCE_REF";
  if (
    /not appear to be a git repository|does not exist|could not read from remote|no such file/i.test(
      diagnostic,
    )
  )
    return "SOURCE_UNAVAILABLE";
  if (/zod|yaml|validation/i.test(String(e.name))) return "SOURCE_VALIDATION";
  return "SOURCE_GIT_OR_VALIDATION";
}
export function configure(ctx: Context, options: Options): unknown {
  if (ctx.manifest.lockBackend === "flock" && options.lockBackend === "mkdir")
    fail(
      "LOCK_BACKEND_UNSUPPORTED",
      "A flock domain cannot downgrade to mkdir; retain its stable kernel lock inode",
    );
  const next = manifestSchema.parse({
    ...ctx.manifest,
    adapter: options.adapter ?? ctx.manifest.adapter,
    hostMetadata:
      options.adapter === "grok" || options.hostMetadata
        ? ["workflow.md", "runs.json"]
        : ctx.manifest.hostMetadata,
    transactionStorage: options.transactionStorage ?? ctx.manifest.transactionStorage,
    runtimeRoot: options.runtimeRoot ?? ctx.manifest.runtimeRoot,
    runtimeVersion: 2,
    lockBackend:
      options.lockBackend ??
      ctx.manifest.lockBackend ??
      (process.platform === "linux" ? "flock" : "mkdir"),
  });
  if (next.transactionStorage) next.transactionStorage = assertNoSymlinks(next.transactionStorage);
  if (next.runtimeRoot) next.runtimeRoot = assertNoSymlinks(next.runtimeRoot);
  const runtime = runtimePath(next.destination, next.runtimeRoot, next.runtimeVersion);
  if (
    inside(ctx.home, runtime) ||
    inside(runtime, ctx.home) ||
    inside(next.destination, runtime) ||
    inside(runtime, next.destination)
  )
    fail("PATH_OVERLAP", "Runtime must be separate from durable state and catalog");
  if (runtime !== ctx.runtime) {
    next.legacyRuntime = ctx.manifest.legacyRuntime ?? ctx.runtime;
    next.legacyLockName =
      ctx.manifest.legacyLockName ??
      (ctx.manifest.runtimeVersion === 2 ? "sync.lock" : "kernel.lock");
  }
  if (next.lockBackend === "flock") {
    if (process.platform !== "linux")
      fail("LOCK_UNAVAILABLE", "Grok kernel backend requires Linux");
    try {
      execFileSync("flock", ["--version"], { stdio: "pipe" });
    } catch {
      fail("LOCK_UNAVAILABLE", "Configured flock executable unavailable");
    }
  }
  const proposed = { ...ctx, manifest: next, runtime };
  storage(proposed, false);
  for (const entry of ctx.lock.entries)
    if (liveHash(targetPath(ctx, entry.id), next.hostMetadata ?? []) !== expectedLive(entry))
      fail("DRIFT", "Configuration cannot adopt unrecognized skill changes");
  if (!options.dryRun) atomicJson(join(ctx.home, "skilltree.json"), next);
  return {
    outcome: options.dryRun ? "WOULD_CONFIGURE" : "CONFIGURED",
    manifest: next,
    message:
      "Stop older writers before migration; new schema and legacy lock guard prevent supported mixed-version writes",
  };
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function migrateStorage(ctx: Context, dryRun: boolean): unknown {
  const moved: string[] = [],
    held: { path: string; reason: string }[] = [];
  const reports = exists(join(ctx.home, "reports"))
    ? fs
        .readdirSync(join(ctx.home, "reports"))
        .filter((n) => n.endsWith(".json"))
        .map(
          (n) =>
            readJson(join(ctx.home, "reports", n)) as {
              result?: { id?: string; outcome?: string; retainedBackup?: string };
            },
        )
    : [];
  for (const name of fs.readdirSync(ctx.manifest.destination)) {
    if (
      !name.startsWith(".skilltree-transaction-") ||
      !uuid.test(name.slice(".skilltree-transaction-".length))
    )
      continue;
    const from = assertNoSymlinks(join(ctx.manifest.destination, name));
    const transaction = name.slice(".skilltree-transaction-".length);
    const to = join(storageRoot(ctx), transaction);
    const receiptPath = join(ctx.home, "storage-migrations", transaction + ".json");
    const proof = reports.find(
      (r) =>
        r.result?.outcome === "UPDATED" &&
        r.result.retainedBackup === join(from, "backup") &&
        ctx.lock.entries.some((e) => e.id === r.result?.id),
    );
    try {
      if (!proof) fail("OWNERSHIP_HELD", "No matching successful deployment report");
      const digest = liveHash(join(from, "backup"), ctx.manifest.hostMetadata ?? []);
      if (!digest) fail("OWNERSHIP_HELD", "Recognized backup is missing");
      getObject(ctx.home, digest);
      storage(ctx, false);
      if (exists(to)) fail("OWNERSHIP_HELD", "Relocation target exists; preserve both");
      if (!dryRun) {
        storage(ctx, true);
        atomicJson(receiptPath, { version: 1, from, to, id: proof.result!.id, hash: digest });
        fs.renameSync(from, to);
        // Only backup bytes are owned; root notes/stage are preserved and hold retention.
        rememberBackup(to, getObject(ctx.home, digest), ctx.home);
      }
      moved.push(to);
    } catch (error) {
      held.push({ path: from, reason: error instanceof Error ? error.message : "Migration held" });
    }
  }
  // External backups from earlier candidates already sit outside the catalog.
  // Attest only exact report-recognized content; metadata/notes stay unowned.
  const external = storageRoot(ctx);
  if (exists(external)) {
    storage(ctx, false);
    for (const name of fs.readdirSync(external))
      if (uuid.test(name)) {
        const root = join(external, name);
        if (exists(join(root, "owner.json"))) continue;
        const proof = reports.find(
          (r) =>
            r.result?.outcome === "UPDATED" &&
            r.result.retainedBackup === join(root, "backup") &&
            ctx.lock.entries.some((e) => e.id === r.result?.id),
        );
        if (!proof) {
          held.push({ path: root, reason: "Unrecognized external backup retained" });
          continue;
        }
        try {
          const digest = liveHash(join(root, "backup"), ctx.manifest.hostMetadata ?? []);
          if (!digest) fail("OWNERSHIP_HELD", "Backup missing");
          const tree = getObject(ctx.home, digest);
          if (!dryRun) rememberBackup(root, tree, ctx.home);
          if (!moved.includes(root)) moved.push(root);
        } catch (error) {
          held.push({ path: root, reason: error instanceof Error ? error.message : "Backup held" });
        }
      }
  }
  // Restart after an atomic rename but before ownership publication.
  const receipts = join(ctx.home, "storage-migrations");
  if (!dryRun && exists(receipts))
    for (const name of fs.readdirSync(receipts)) {
      const record = readJson(join(receipts, name)) as {
        from?: string;
        to?: string;
        hash?: string;
      };
      if (
        record.to &&
        record.from &&
        dirname(record.to) === storageRoot(ctx) &&
        dirname(record.from) === ctx.manifest.destination &&
        !exists(record.from) &&
        exists(record.to) &&
        !exists(join(record.to, "owner.json"))
      ) {
        if (liveHash(join(record.to, "backup"), ctx.manifest.hostMetadata ?? []) === record.hash)
          rememberBackup(record.to, getObject(ctx.home, record.hash!), ctx.home);
      }
    }
  return { outcome: dryRun ? "WOULD_MIGRATE" : "MIGRATED", moved, held };
}
function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function legacyObjectCache(
  ctx: Context,
  root: string,
  archiveKey?: string,
): { root: string; record: Ownership; marker: string } | null {
  const objectRoot = assertNoSymlinks(join(root, ".git", "objects"));
  if (!exists(objectRoot)) return null;
  const paths = inventory(objectRoot);
  if (
    Object.keys(paths).some(
      (path) =>
        !/^(?:[a-f0-9]{2}(?:\/[a-f0-9]{38,62})?|pack(?:\/pack-[a-f0-9]{40,64}\.(?:pack|idx|rev))?|info(?:\/packs)?)$/.test(
          path,
        ),
    )
  )
    fail("OWNERSHIP_HELD", "Unknown Git object storage retained");
  const objectIds = gitBytes(root, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname)",
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const keys = archiveKey
    ? [archiveKey]
    : fs
        .readdirSync(join(ctx.home, "archives"))
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.slice(0, -5));
  for (const key of keys) {
    const archive = readArchive(ctx.home, key);
    if (
      archive.version !== 2 ||
      archive.kind !== "source" ||
      !objectIds.every((oid) => archive.objects[oid])
    )
      continue;
    if (git(root, ["remote", "get-url", "origin"]) !== archive.repository) continue;
    const flags = gitBytes(root, ["ls-files", "-v", "-z"]).toString().split("\0");
    if (flags.some((row) => row && (row[0] === "S" || /[a-z]/.test(row[0]!))))
      fail("OWNERSHIP_HELD", "Concealed index work retained");
    const rows = gitBytes(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored",
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
    if (rows.some((row) => row.slice(0, 2) !== " D"))
      fail("OWNERSHIP_HELD", "Changed or unknown legacy cache work retained");
    // Object bytes are verified against the archive; refs/config/logs/index are
    // deliberately retained because legacy ownership of their bytes is unknown.
    for (const { oid, type, data } of gitObjects(root)) {
      const value = readJson(
        join(ctx.home, "archive-objects", archive.objects[oid]! + ".json"),
      ) as { type: string; data: string };
      if (type !== value.type || !data.equals(Buffer.from(value.data, "base64")))
        fail("ARCHIVE_CORRUPT", "Legacy object differs from durable archive");
    }
    return {
      root: objectRoot,
      record: { version: 1, root: objectRoot, archive: key, pid: process.pid, files: paths },
      marker: "",
    };
  }
  fail("OWNERSHIP_HELD", "No complete verified archive for legacy Git cache");
}
export function compact(ctx: Context, options: Options): unknown {
  if (
    options.retainBackups !== undefined &&
    (!Number.isSafeInteger(options.retainBackups) || options.retainBackups < 0)
  )
    fail("USAGE", "Retain count must be a nonnegative integer");
  if (
    !options.caches &&
    !options.scratch &&
    options.retainBackups === undefined &&
    !options.retainedDirectories &&
    !options.backupScratch
  )
    fail("USAGE", "Choose an explicit documented compact policy");
  const candidates: {
    root: string;
    kind: string;
    record: Ownership;
    marker: string;
    excluded: string[];
  }[] = [];
  const held: { root: string; reason: string }[] = [];
  const add = (
    root: string,
    kind: string,
    marker: string,
    excluded: string[],
    validate: () => void,
  ) => {
    try {
      assertNoSymlinks(root);
      const record = ownershipSchema.parse(readJson(marker));
      if (kind === "backup" && record.collection !== ctx.home)
        fail("OWNERSHIP_HELD", "Backup belongs to another or unrecognized collection");
      if (kind !== "cache" && record.root !== root)
        fail("OWNERSHIP_HELD", "Ownership locator differs");
      if (!exists(root)) return;
      validate();
      if (validateOwned(root, record, excluded).length)
        fail("OWNERSHIP_HELD", "Unknown or changed work retained");
      candidates.push({ root, kind, record, marker, excluded });
    } catch (error) {
      held.push({ root, reason: error instanceof Error ? error.message : "Ownership held" });
    }
  };
  const packed: string[] = [];
  // Packing is an explicit cache-policy action, never a normal read/acquisition.
  // Verify full owned bytes and immutable history before using Git's packer;
  // preserve the complete object set and all refs, with no shallow conversion.
  if (options.caches)
    for (const source of ctx.lock.sources) {
      const root = sourcePath(ctx.home, source),
        marker = materializationRecord(ctx.home, root);
      try {
        if (!source.archive || !exists(marker))
          fail("OWNERSHIP_HELD", "Active legacy cache needs proven ownership before packing");
        const record = ownershipSchema.parse(readJson(marker));
        if (record.archive !== source.archive || validateOwned(root, record).length)
          fail("OWNERSHIP_HELD", "Changed active cache retained");
        const archive = readArchive(ctx.home, source.archive);
        if (
          archive.kind !== "source" ||
          archive.id !== source.id ||
          archive.revision !== source.revision
        )
          fail("ARCHIVE_MISMATCH", "Active source archive differs");
        preflightSource(root, source.repository, source.revision);
        if (!options.dryRun) {
          const before = gitBytes(root, [
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname)",
          ])
            .toString()
            .trim()
            .split("\n")
            .sort();
          git(root, ["repack", "-a", "-d", "--keep-unreachable"]);
          const after = gitBytes(root, [
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname)",
          ])
            .toString()
            .trim()
            .split("\n")
            .sort();
          if (JSON.stringify(before) !== JSON.stringify(after))
            fail(
              "ARCHIVE_MISMATCH",
              "Packing changed the object set; retain archive and inspect cache",
            );
          preflightSource(root, source.repository, source.revision);
          rememberMaterialization(ctx.home, root, source.archive);
        }
        packed.push(root);
      } catch (error) {
        held.push({
          root,
          reason: error instanceof Error ? error.message : "Active cache packing held",
        });
      }
    }
  if (options.caches) {
    const active = new Set([
      ...ctx.lock.sources.map((s) => sourcePath(ctx.home, s)),
      ...ctx.lock.entries.filter((e) => e.local).map((e) => localPath(ctx.home, e.id, e.local)),
    ]);
    const records = join(ctx.home, "materializations");
    if (exists(records))
      for (const name of fs.readdirSync(records)) {
        const marker = join(records, name);
        const record = ownershipSchema.parse(readJson(marker));
        const root = assertNoSymlinks(join(ctx.home, record.root));
        if (active.has(root)) continue;
        add(root, "cache", marker, [], () => {
          if (
            (!inside(join(ctx.home, "repos"), root) && !inside(join(ctx.home, "edits"), root)) ||
            !record.archive
          )
            fail("OWNERSHIP_HELD", "Cache provenance missing");
          readArchive(ctx.home, record.archive);
        });
      }
  }
  if (options.caches && exists(join(ctx.home, "repos"))) {
    const active = new Set(ctx.lock.sources.map((s) => sourcePath(ctx.home, s)));
    for (const name of fs.readdirSync(join(ctx.home, "repos"))) {
      const root = join(ctx.home, "repos", name);
      if (
        active.has(root) ||
        candidates.some((c) => c.root === root) ||
        !/^[a-z0-9_-]+-[a-f0-9-]{36}$/.test(name)
      )
        continue;
      const ownerPath = materializationRecord(ctx.home, root);
      if (exists(ownerPath) && Object.keys(ownershipSchema.parse(readJson(ownerPath)).files).length)
        continue;
      try {
        const cache = legacyObjectCache(ctx, root);
        if (cache) candidates.push({ ...cache, kind: "legacy-git-cache", excluded: [] });
      } catch (error) {
        if (!held.some((h) => h.root === root))
          held.push({ root, reason: error instanceof Error ? error.message : "Cache held" });
      }
    }
  }
  if (options.retainBackups !== undefined) {
    if (!Number.isSafeInteger(options.retainBackups) || options.retainBackups < 0)
      fail("USAGE", "Retain count must be a nonnegative integer");
    const root = storageRoot(ctx);
    if (exists(root)) {
      storage(ctx, false);
      const dirs = fs
        .readdirSync(root)
        .filter((n) => uuid.test(n))
        .map((n) => join(root, n))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const start = candidates.length;
      for (const dir of dirs) add(dir, "backup", join(dir, "owner.json"), ["owner.json"], () => {});
      const verified = candidates.splice(start);
      // Unknown/changed directories do not consume the keep count or become
      // deletion candidates. Empty proven transaction caches can be removed.
      candidates.push(
        ...verified.filter((c) => !exists(join(c.root, "backup"))),
        ...verified.filter((c) => exists(join(c.root, "backup"))).slice(options.retainBackups),
      );
    }
  }
  if (options.scratch) {
    const stages = join(ctx.runtime, "stages");
    if (exists(stages))
      for (const name of fs.readdirSync(stages)) {
        if (!uuid.test(name)) continue;
        const root = join(stages, name),
          marker = join(root, "owner.json");
        add(root, "scratch", marker, ["owner.json"], () => {
          const record = ownershipSchema.parse(readJson(marker));
          if (record.root !== root || !exited(record.pid))
            fail("OWNERSHIP_HELD", "Scratch owner is live or unrecognized");
        });
      }
  }
  if (!options.dryRun)
    for (const candidate of candidates) {
      removeOwned(candidate.root, candidate.record, candidate.excluded);
      if (candidate.excluded.includes("owner.json")) fs.unlinkSync(candidate.marker);
      fs.rmdirSync(candidate.root);
    }
  const library = compactLibrary(ctx, options);
  return {
    outcome: options.dryRun ? "WOULD_COMPACT" : "COMPACTED",
    policy: {
      caches: !!options.caches,
      scratch: !!options.scratch,
      retainBackups: options.retainBackups ?? null,
      retainedDirectories: !!options.retainedDirectories,
      backupScratch: !!options.backupScratch,
    },
    candidates: [
      ...library.candidates,
      ...candidates.map((c) => ({
        root: c.root,
        kind: c.kind,
        files: Object.keys(c.record.files).length,
      })),
    ],
    held: [...held, ...library.held],
    packed,
  };
}
export function stageScratch(ctx: Context): string {
  const parent = assertNoSymlinks(join(ctx.runtime, "stages"));
  fs.mkdirSync(parent, { recursive: true });
  const root = join(parent, randomUUID());
  fs.mkdirSync(root);
  checkpointScratch(root);
  return root;
}
export function checkpointScratch(root: string): void {
  const files = requireInventory(root, ["owner.json"]);
  atomicJson(join(root, "owner.json"), { version: 1, root, pid: process.pid, files });
}
import { inventory as requireInventory } from "./ownership";
