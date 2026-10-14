import { prepareBlobIntent, checkpointBlobCreation, type BoundaryHook } from "./scratch-journal";
import { rememberRetained, finishRetained, forgetBlobTemp } from "./library-maintenance";
import * as fs from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { checkMetadata, mountId, mountTable, sameMount } from "./filesystem-capabilities";
import { z } from "zod";
import { fail, hash, lockSchema, type Lock } from "./model";
import {
  assertNoSymlinks,
  atomicJson,
  readJson,
  exists,
  inside,
  readTree,
  treeHash,
  storageWrite,
} from "./files";
import { save, type Context } from "./state";
import { storageRoot, storage as ensureStorage } from "./deployment";

const pathSchema = z
  .string()
  .refine(
    (p) =>
      p === "" ||
      (!p.startsWith("/") &&
        !p.includes("\\") &&
        !p.includes("\0") &&
        p.split("/").every((s) => s && ![".", "..", "__proto__"].includes(s))),
  );
const rowSchema = z
  .object({
    kind: z.enum(["directory", "file", "link"]),
    mode: z.number().int().min(0).max(511),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    blob: hash.optional(),
    target: z.string().optional(),
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
const treeSchema = z
  .object({ exists: z.boolean(), rows: z.record(pathSchema, rowSchema) })
  .strict();
type DirectoryTree = z.infer<typeof treeSchema>;
const snapshotSchema = z
  .object({
    version: z.literal(1),
    id: hash,
    collection: z.string(),
    destination: z.string(),
    at: z.string(),
    reason: z.string(),
    tree: treeSchema,
    hash,
    lock: lockSchema,
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;
const journalSchema = z
  .object({
    version: z.literal(1),
    transaction: z.string().uuid(),
    collection: z.string(),
    storage: z.string(),
    from: hash,
    to: hash,
    current: hash,
    target: hash,
    before: hash,
    next: lockSchema,
  })
  .strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const blobHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function treeDigest(tree: DirectoryTree): string {
  return digest({
    exists: tree.exists,
    rows: Object.entries(tree.rows).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
}
function blobPath(home: string, key: string): string {
  return assertNoSymlinks(join(home, "library-blobs", hash.parse(key) + ".bin"));
}
function getBlob(home: string, key: string): Buffer {
  const bytes = fs.readFileSync(blobPath(home, key));
  if (blobHash(bytes) !== key) fail("BACKUP_CORRUPT", "Directory blob integrity mismatch");
  return bytes;
}
export function putBlob(
  home: string,
  key: string,
  bytes: Buffer,
  afterIntent?: (temp: string) => void,
  boundary?: BoundaryHook,
): void {
  const path = blobPath(home, key);
  if (exists(path)) {
    getBlob(home, key);
    return;
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  const intent = prepareBlobIntent(home, key, bytes, boundary),
    temp = intent.temp;
  const fd = storageWrite(temp, () => fs.openSync(temp, "wx", 0o600));
  try {
    boundary?.("temp-created", temp);
    checkpointBlobCreation(home, intent.row, fd, boundary);
    boundary?.("created-durable", temp);
    afterIntent?.(temp);
    storageWrite(temp, () => {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    });
    boundary?.("payload-written", temp);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, path);
  boundary?.("blob-published", path);
  forgetBlobTemp(home, temp);
}
export function directoryTree(home: string, root: string, persist = false): DirectoryTree {
  assertNoSymlinks(root);
  if (!exists(root)) return { exists: false, rows: {} };
  const rows: DirectoryTree["rows"] = Object.create(null),
    paths: string[] = [];
  const device = fs.lstatSync(root).dev;
  const mounts = process.platform === "linux" ? mountTable() : null;
  const rootMount = mounts ? mountId(root) : null;
  let count = 0,
    bytes = 0;
  function walk(path: string, key: string) {
    pathSchema.parse(key);
    const before = fs.lstatSync(path);
    paths.push(path);
    count++;
    if (count > 25000) fail("BACKUP_LIMIT", `Entry count exceeds 25,000: ${path}`);
    if (mounts ? mountId(path) !== rootMount : before.dev !== device)
      fail("BACKUP_MOUNT", `Nested or different filesystem mount: ${path}`);
    if (before.mode & 0o7000)
      fail("BACKUP_PERMISSIONS", `Special permission bits cannot be restored: ${path}`);
    if (before.uid !== process.getuid?.() || before.gid !== process.getgid?.())
      fail("BACKUP_OWNER", `Entry owner/group differs from this operator: ${path}`);
    const row: Row = {
      kind: before.isSymbolicLink() ? "link" : before.isDirectory() ? "directory" : "file",
      mode: before.mode & 0o777,
      uid: before.uid,
      gid: before.gid,
    };
    if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(path),
        lexical = resolve(dirname(path), target);
      let real: string;
      try {
        real = fs.realpathSync(lexical);
      } catch {
        fail("BACKUP_UNSUPPORTED", `Dangling or unreadable symlink: ${path}`);
      }
      if (
        target.startsWith("/") ||
        !inside(root, lexical) ||
        !inside(root, real!) ||
        (mounts !== null && mountId(real!) !== rootMount)
      )
        fail(
          "BACKUP_UNSUPPORTED",
          `Only resolvable relative in-tree symlinks on the same mount can be backed up: ${path}`,
        );
      row.target = target;
    } else if (before.isDirectory()) {
      rows[key] = row;
      for (const name of fs.readdirSync(path).sort())
        walk(join(path, name), key ? key + "/" + name : name);
    } else if (before.isFile()) {
      if (before.nlink !== 1)
        fail("BACKUP_HARDLINK", `Hardlinked file cannot be faithfully restored: ${path}`);
      if (before.size > 10_000_000) fail("BACKUP_LIMIT", `File size exceeds 10 MB: ${path}`);
      const data = fs.readFileSync(path);
      bytes += data.length;
      if (bytes > 200_000_000)
        fail("BACKUP_LIMIT", `Directory backup exceeds 200 MB supported limit: ${path}`);
      row.blob = blobHash(data);
      if (persist) putBlob(home, row.blob, data);
    } else fail("BACKUP_UNSUPPORTED", `Special filesystem entry cannot be restored: ${path}`);
    rows[key] = row;
    const after = fs.lstatSync(path);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail("BACKUP_CHANGED", `Directory changed while being read: ${path}`);
  }
  walk(root, "");
  checkMetadata(root, paths);
  if (mounts !== null && mountTable() !== mounts)
    fail("BACKUP_CHANGED", `Mount table changed during backup: ${root}`);
  return treeSchema.parse({ exists: true, rows });
}
export function libraryHash(ctx: Context): string {
  return treeDigest(directoryTree(ctx.home, ctx.manifest.destination));
}
function pointPath(ctx: Context, id: string): string {
  return join(ctx.home, "library-backups", hash.parse(id) + ".json");
}
export function readLibrarySnapshot(ctx: Context, id: string): Snapshot {
  const point = snapshotSchema.parse(readJson(pointPath(ctx, id)));
  if (
    point.collection !== ctx.home ||
    point.destination !== ctx.manifest.destination ||
    point.hash !== treeDigest(point.tree) ||
    point.id !== id
  )
    fail("BACKUP_CORRUPT", "Recovery point identity or tree integrity mismatch");
  const { id: pointId, ...body } = point;
  if (digest(body) !== pointId) fail("BACKUP_CORRUPT", "Recovery manifest integrity mismatch");
  for (const [path, row] of Object.entries(point.tree.rows)) {
    if (row.uid !== process.getuid?.() || row.gid !== process.getgid?.())
      fail("BACKUP_UNSUPPORTED", "Recovery point ownership differs from this operator");
    if (row.kind === "file") {
      if (!row.blob || row.target) fail("BACKUP_CORRUPT", "Invalid file record");
      getBlob(ctx.home, row.blob);
    }
    if (row.kind === "directory" && (row.blob || row.target))
      fail("BACKUP_CORRUPT", "Invalid directory record");
    if (row.kind === "link") {
      if (
        !row.target ||
        row.blob ||
        row.target.startsWith("/") ||
        !inside(
          ctx.manifest.destination,
          resolve(dirname(join(ctx.manifest.destination, path)), row.target),
        )
      )
        fail("BACKUP_CORRUPT", "Invalid symlink record");
    }
    if (path && point.tree.rows[dirname(path) === "." ? "" : dirname(path)]?.kind !== "directory")
      fail("BACKUP_CORRUPT", "Missing parent directory");
  }
  if (
    point.tree.exists !== !!point.tree.rows[""] ||
    (point.tree.exists && point.tree.rows[""]?.kind !== "directory")
  )
    fail("BACKUP_CORRUPT", "Invalid root record");
  return point;
}
export function createLibrarySnapshot(ctx: Context, reason: string): Snapshot {
  if (!ctx.manifest.libraryRecoveryVersion) {
    ctx.manifest = { ...ctx.manifest, libraryRecoveryVersion: 1 };
    atomicJson(join(ctx.home, "skilltree.json"), ctx.manifest);
  }
  const tree = directoryTree(ctx.home, ctx.manifest.destination, true),
    key = treeDigest(tree);
  if (libraryHash(ctx) !== key)
    fail("BACKUP_CHANGED", "Library changed before snapshot publication");
  const body = {
    version: 1,
    collection: ctx.home,
    destination: ctx.manifest.destination,
    at: new Date().toISOString(),
    reason,
    tree,
    hash: key,
    lock: lockSchema.parse(ctx.lock),
  };
  const point: Snapshot = { ...body, version: 1, id: digest(body) };
  atomicJson(pointPath(ctx, point.id), point);
  readLibrarySnapshot(ctx, point.id);
  if (libraryHash(ctx) !== key) fail("BACKUP_CHANGED", "Library changed after backup verification");
  return point;
}
export function libraryBackups(ctx: Context): unknown {
  const root = join(ctx.home, "library-backups");
  return {
    outcome: "CURRENT",
    backups: exists(root)
      ? fs
          .readdirSync(root)
          .filter((n) => n.endsWith(".json"))
          .map((name) => {
            const p = readLibrarySnapshot(ctx, name.slice(0, -5));
            return {
              id: p.id,
              at: p.at,
              reason: p.reason,
              hash: p.hash,
              entries: Object.keys(p.tree.rows).length,
            };
          })
      : [],
  };
}
export function libraryPending(ctx: Context): boolean {
  return exists(join(ctx.home, "library-transaction.json"));
}
function transactionPaths(ctx: Context, id: string) {
  const root = assertNoSymlinks(join(storageRoot(ctx), "library-" + z.string().uuid().parse(id)));
  return { root, stage: join(root, "stage"), prior: join(root, "prior") };
}
function materialize(ctx: Context, point: Snapshot, root: string): void {
  if (!point.tree.exists) return;
  fs.mkdirSync(root, { mode: 0o700 });
  const entries = Object.entries(point.tree.rows).filter(([path]) => path);
  for (const [path] of entries
    .filter(([, r]) => r.kind === "directory")
    .sort(([a], [b]) => a.length - b.length))
    fs.mkdirSync(join(root, path), { mode: 0o700 });
  for (const [path, row] of entries.filter(([, r]) => r.kind === "file")) {
    const target = join(root, path);
    storageWrite(target, () =>
      fs.writeFileSync(target, getBlob(ctx.home, row.blob!), { flag: "wx", mode: 0o600 }),
    );
    fs.chmodSync(target, row.mode);
  }
  for (const [path, row] of entries.filter(([, r]) => r.kind === "link"))
    fs.symlinkSync(row.target!, join(root, path));
  for (const [path, row] of Object.entries(point.tree.rows)
    .filter(([, r]) => r.kind === "directory")
    .sort(([a], [b]) => b.length - a.length))
    fs.chmodSync(path ? join(root, path) : root, row.mode);
  if (treeDigest(directoryTree(ctx.home, root)) !== point.hash)
    fail("BACKUP_CORRUPT", "Restored staging directory differs from snapshot");
}
function diff(before: DirectoryTree, after: DirectoryTree): unknown {
  const added: string[] = [],
    removed: string[] = [],
    changed: string[] = [];
  for (const path of [
    ...new Set([...Object.keys(before.rows), ...Object.keys(after.rows)]),
  ].sort()) {
    if (!before.rows[path]) added.push(path || ".");
    else if (!after.rows[path]) removed.push(path || ".");
    else if (JSON.stringify(before.rows[path]) !== JSON.stringify(after.rows[path]))
      changed.push(path || ".");
  }
  return { added, removed, changed, rootExists: { before: before.exists, after: after.exists } };
}
function restoredOwnership(ctx: Context, target: Snapshot): Lock {
  const next = lockSchema.parse(ctx.lock);
  for (const oldSource of target.lock.sources) {
    const currentSource = next.sources.find((s) => s.id === oldSource.id);
    if (currentSource && currentSource.repository !== oldSource.repository)
      fail("REVERT_AMBIGUOUS", "Removed source ID was reused for another repository");
    if (!currentSource) next.sources.push(oldSource);
  }
  // A guarded removal retires ownership only after retaining a complete point.
  // Restoring that point must bring its selections back without discarding newer
  // sources or local history belonging to selections which still exist.
  for (const entry of target.lock.entries) {
    if (next.entries.some((e) => e.id === entry.id)) continue;
    const oldSource = target.lock.sources.find((s) => s.id === entry.source)!;
    const currentSource = next.sources.find((s) => s.id === entry.source);
    if (currentSource && currentSource.repository !== oldSource.repository)
      fail("REVERT_AMBIGUOUS", "Removed source ID was reused for another repository");
    if (!currentSource) next.sources.push(oldSource);
    next.entries.push(entry);
  }
  for (const entry of next.entries) {
    const old = target.lock.entries.find((e) => e.id === entry.id);
    if (old && (old.source !== entry.source || old.path !== entry.path || old.name !== entry.name))
      fail("REVERT_AMBIGUOUS", "Selection identity changed since the recovery point");
  }
  return next;
}
function nextLock(ctx: Context, target: Snapshot, stage: string): Lock {
  const next = restoredOwnership(ctx, target);
  next.entries = next.entries.map((entry) => {
    const old = target.lock.entries.find((e) => e.id === entry.id);
    const restored = {
      ...entry,
      deployed: old?.deployed ?? null,
      observed: old?.observed ?? null,
      deployedBase: old?.deployedBase ?? null,
      candidate: null,
      approval: null,
      removal: undefined,
      outcome: "HELD" as const,
      reasons: [
        "Library reverted; current source/local history retained. Sync and review before applying again.",
      ],
    };
    try {
      const path = join(stage, entry.id);
      const actual =
        target.tree.exists && exists(path)
          ? treeHash(readTree(path, false, ctx.manifest.hostMetadata ?? []))
          : null;
      const expected = restored.observed ?? restored.deployed?.hash ?? null;
      if (actual !== expected)
        return {
          ...restored,
          outcome: "DRIFT" as const,
          reasons: [
            "Restored bytes differ from recorded ownership; inspect and explicitly capture/reconcile",
          ],
        };
    } catch {
      return {
        ...restored,
        outcome: "DRIFT" as const,
        reasons: ["Restored skill is unsupported; preserve and reconcile"],
      };
    }
    return restored;
  });
  return next;
}
export function revertLibrary(
  ctx: Context,
  id: string,
  expected: string | undefined,
  dryRun: boolean,
  quietHost = false,
  afterMove?: () => void,
  afterPlace?: () => void,
  afterIntent?: () => void,
): unknown {
  const target = readLibrarySnapshot(ctx, id),
    currentTree = directoryTree(ctx.home, ctx.manifest.destination),
    currentHash = treeDigest(currentTree),
    changes = diff(currentTree, target.tree);
  if (expected && hash.parse(expected) !== currentHash)
    fail("REVERT_STALE", "Library changed after the reviewed diff");
  restoredOwnership(ctx, target);
  if (dryRun)
    return {
      outcome: "WOULD_REVERT",
      snapshot: id,
      expected: currentHash,
      target: target.hash,
      diff: changes,
    };
  if (!expected) fail("USAGE", "Actual revert requires --expect from the reviewed dry run");
  if (
    currentHash === target.hash &&
    digest(nextLock(ctx, target, ctx.manifest.destination)) === digest(ctx.lock)
  )
    return { outcome: "CURRENT", snapshot: id, diff: changes };
  if (!quietHost)
    fail(
      "HOST_NOT_QUIET",
      "Actual directory revert requires --quiet-host after stopping host catalog and other writers; the directory temporarily disappears",
    );
  const current = createLibrarySnapshot(ctx, "before revert to " + id),
    transaction = randomUUID(),
    p = transactionPaths(ctx, transaction);
  const storage = storageRoot(ctx);
  ensureStorage(ctx, true);
  if (!sameMount(storage, dirname(ctx.manifest.destination)))
    fail("BACKUP_UNSUPPORTED", "Revert staging must share the destination filesystem");
  fs.mkdirSync(p.root);
  materialize(ctx, target, p.stage);
  rememberRetained(ctx, transaction, current.id, target.id);
  const next = nextLock(ctx, target, p.stage);
  if (libraryHash(ctx) !== currentHash)
    fail("REVERT_STALE", "Library changed before replacement; current state preserved");
  const journal = {
    version: 1 as const,
    transaction,
    collection: ctx.home,
    storage,
    from: currentHash,
    to: target.hash,
    current: current.id,
    target: id,
    before: digest(ctx.lock),
    next,
  };
  atomicJson(join(ctx.home, "library-transaction.json"), journal);
  afterIntent?.();
  if (libraryHash(ctx) !== currentHash)
    fail("REVERT_STALE", "Library changed during restore intent; recover before proceeding");
  if (currentTree.exists) fs.renameSync(ctx.manifest.destination, p.prior);
  afterMove?.();
  if (exists(ctx.manifest.destination))
    fail("REVERT_STALE", "Directory reappeared; preserve it and recover");
  if (target.tree.exists) fs.renameSync(p.stage, ctx.manifest.destination);
  afterPlace?.();
  if (libraryHash(ctx) !== target.hash)
    fail("REVERT_STALE", "Restored directory changed; recover without overwriting it");
  ctx.lock = next;
  save(ctx);
  fs.unlinkSync(join(ctx.home, "library-transaction.json"));
  finishRetained(ctx, transaction);
  return {
    outcome: "REVERTED",
    snapshot: id,
    currentRecoveryPoint: current.id,
    diff: changes,
    retainedPrior: currentTree.exists ? p.prior : null,
  };
}
export function recoverLibrary(
  ctx: Context,
  dryRun: boolean,
  keepCurrent = false,
  expected?: string,
  quietHost = false,
): unknown {
  const journal = journalSchema.parse(readJson(join(ctx.home, "library-transaction.json")));
  if (journal.collection !== ctx.home || journal.storage !== storageRoot(ctx))
    fail("STATE_INVALID", "Library restore journal ownership differs");
  if (!dryRun && !quietHost)
    fail(
      "HOST_NOT_QUIET",
      "Actual directory recovery requires --quiet-host after stopping host catalog and other writers",
    );
  readLibrarySnapshot(ctx, journal.current);
  readLibrarySnapshot(ctx, journal.target);
  const state = digest(ctx.lock);
  if (state !== journal.before && state !== digest(journal.next))
    fail("REVERT_AMBIGUOUS", "Collection state changed outside the interrupted restore");
  const p = transactionPaths(ctx, journal.transaction),
    actual = libraryHash(ctx);
  if (keepCurrent) {
    if (expected && hash.parse(expected) !== actual)
      fail("REVERT_STALE", "Current directory changed after reviewed recovery diff");
    if (dryRun) return { outcome: "WOULD_KEEP_CURRENT", expected: actual, retainedPrior: p.prior };
    if (!expected) fail("USAGE", "Keeping newer current data requires --expect from dry run");
    const point = createLibrarySnapshot(ctx, "before canceling interrupted revert; keep current");
    if (libraryHash(ctx) !== actual)
      fail("REVERT_STALE", "Directory changed after current-state backup");
    fs.unlinkSync(join(ctx.home, "library-transaction.json"));
    finishRetained(ctx, journal.transaction);
    return {
      outcome: "RECOVERED",
      action: "keep current directory; ownership drift requires explicit reconciliation",
      currentRecoveryPoint: point.id,
      retainedPrior: p.prior,
    };
  }
  if (actual === journal.to) {
    if (!dryRun) {
      ctx.lock = journal.next;
      save(ctx);
      fs.unlinkSync(join(ctx.home, "library-transaction.json"));
      finishRetained(ctx, journal.transaction);
    }
    return {
      outcome: dryRun ? "WOULD_COMPLETE" : "RECOVERED",
      action: "complete directory restoration",
      currentRecoveryPoint: journal.current,
    };
  }
  if (
    !exists(ctx.manifest.destination) &&
    exists(p.prior) &&
    treeDigest(directoryTree(ctx.home, p.prior)) === journal.from
  ) {
    if (!dryRun) {
      fs.renameSync(p.prior, ctx.manifest.destination);
      fs.unlinkSync(join(ctx.home, "library-transaction.json"));
      finishRetained(ctx, journal.transaction);
    }
    return {
      outcome: dryRun ? "WOULD_ROLLBACK" : "RECOVERED",
      action: "retain pre-revert directory",
      currentRecoveryPoint: journal.current,
    };
  }
  if (actual === journal.from && !exists(p.prior)) {
    if (!dryRun) {
      fs.unlinkSync(join(ctx.home, "library-transaction.json"));
      finishRetained(ctx, journal.transaction);
    }
    return {
      outcome: dryRun ? "WOULD_ABORT" : "RECOVERED",
      action: "retain unchanged directory",
      currentRecoveryPoint: journal.current,
    };
  }
  fail(
    "DRIFT",
    "Interrupted directory restoration found newer or unknown bytes; retain journal, prior directory and recovery points for inspection",
  );
}
