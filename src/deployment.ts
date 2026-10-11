import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail, type Entry, type Journal } from "./model";
import {
  atomicJson,
  assertNoSymlinks,
  exists,
  getObject,
  liveHash,
  writeTree,
  inside,
  readJson,
} from "./files";
import { pending, save, type Context } from "./state";
import { localPath, preflightLocal, recordLocal } from "./git";

import { archiveRepository } from "./archives";

export function expectedLive(entry: Entry): string | null {
  return entry.observed ?? entry.deployed?.hash ?? null;
}
export function destinationHash(ctx: Context, path: string): string | null {
  return liveHash(path, ctx.manifest.hostMetadata ?? []);
}
export function targetPath(ctx: Context, id: string): string {
  return assertNoSymlinks(join(ctx.manifest.destination, id));
}
export function storageRoot(ctx: Context): string {
  const destination = ctx.manifest.destination;
  const root = assertNoSymlinks(
    join(
      dirname(destination),
      `.skilltree-storage-${createHash("sha256").update(destination).digest("hex")}`,
    ),
  );
  if (inside(ctx.home, root) || inside(root, ctx.home) || inside(destination, root))
    fail("PATH_OVERLAP", "Transaction storage must be separate from state and catalog");
  return root;
}
function storage(ctx: Context, create: boolean): string {
  const root = storageRoot(ctx);
  const marker = join(root, "owner.json");
  if (exists(root)) {
    const owner = exists(marker)
      ? (readJson(marker) as { version?: unknown; destination?: unknown })
      : null;
    if (!owner || owner.version !== 1 || owner.destination !== ctx.manifest.destination)
      fail("STORAGE_UNOWNED", "Transaction storage exists without matching ownership; preserve it");
  } else if (create) {
    fs.mkdirSync(root, { mode: 0o700 });
    atomicJson(marker, { version: 1, destination: ctx.manifest.destination });
  }
  if (
    fs.statSync(exists(root) ? root : dirname(root)).dev !==
    fs.statSync(ctx.manifest.destination).dev
  )
    fail("STORAGE_FILESYSTEM", "Transaction storage must share the destination filesystem");
  fs.accessSync(exists(root) ? root : dirname(root), fs.constants.R_OK | fs.constants.W_OK);
  return root;
}
export function paths(ctx: Context, transaction: string, legacy = false) {
  const root = assertNoSymlinks(
    legacy
      ? join(ctx.manifest.destination, `.skilltree-transaction-${transaction}`)
      : join(storageRoot(ctx), transaction),
  );
  return { root, stage: join(root, "stage"), backup: join(root, "backup") };
}
function finish(ctx: Context, journal: Journal): void {
  const index = ctx.lock.entries.findIndex((e) => e.id === journal.id);
  if (index < 0) fail("STATE_INVALID", "Transaction ownership record is missing");
  ctx.lock.entries[index] = journal.next;
  save(ctx);
  fs.unlinkSync(join(ctx.home, "transaction.json"));
}
export function applyEntry(
  ctx: Context,
  entry: Entry,
  requestedHash: string,
  dryRun: boolean,
  afterBackup?: () => void,
): unknown {
  if (!entry.candidate || entry.candidate.hash !== requestedHash)
    fail("STALE_CANDIDATE", "Requested hash is not the current staged candidate");
  if (entry.approval?.hash !== requestedHash)
    fail("HELD", "Approve the exact candidate hash before applying");
  const tree = getObject(ctx.home, requestedHash);
  const target = targetPath(ctx, entry.id);
  const oldHash = expectedLive(entry);
  if (destinationHash(ctx, target) !== oldHash)
    fail(
      oldHash ? "DRIFT" : "COLLISION",
      "Destination differs from the accepted ownership baseline; capture or reconcile it first",
    );
  preflightLocal(ctx.home, entry.id, entry.local);
  if (entry.deployed?.hash === requestedHash && !entry.observed)
    return { id: entry.id, outcome: "CURRENT", hash: requestedHash };
  storage(ctx, false);
  if (dryRun) return { id: entry.id, outcome: "WOULD_APPLY", hash: requestedHash };
  storage(ctx, true);
  const next: Entry = {
    ...entry,
    deployed: entry.candidate,
    deployedBase: entry.upstream.hash,
    observed: null,
    outcome: "UPDATED",
    reasons: [],
  };
  if (entry.local)
    next.local = {
      hash: requestedHash,
      base: entry.upstream.hash,
      commit: recordLocal(ctx.home, entry.id, tree, entry.local),
      ...(entry.local.checkout ? { checkout: entry.local.checkout } : {}),
    };
  if (next.local)
    next.local.archive = archiveRepository(
      ctx.home,
      localPath(ctx.home, entry.id, next.local),
      "local",
      entry.id,
      next.local.commit,
      null,
    );
  const transaction = randomUUID();
  const p = paths(ctx, transaction);
  fs.mkdirSync(p.root);
  const journal: Journal = {
    version: 2,
    storage: storageRoot(ctx),
    transaction,
    id: entry.id,
    oldHash,
    next,
  };
  atomicJson(join(ctx.home, "transaction.json"), journal);
  writeTree(p.stage, tree);
  if (destinationHash(ctx, p.stage) !== requestedHash)
    fail("STAGING_CHANGED", "Staged file set changed");
  if (destinationHash(ctx, target) !== oldHash)
    fail("DRIFT", "Destination changed before replacement; run recover");
  if (oldHash !== null) fs.renameSync(target, p.backup);
  afterBackup?.();
  if (oldHash !== null && destinationHash(ctx, p.backup) !== oldHash)
    fail("DRIFT", "Concurrent write changed the retained backup; run recover");
  if (exists(target)) fail("DRIFT", "Destination reappeared during replacement; run recover");
  if (oldHash !== null)
    for (const name of ctx.manifest.hostMetadata ?? []) {
      const from = assertNoSymlinks(join(p.backup, name));
      if (!exists(from)) continue;
      if (!fs.lstatSync(from).isFile())
        fail("UNSAFE_TREE", "Host metadata must be regular root files");
      fs.copyFileSync(from, join(p.stage, name), fs.constants.COPYFILE_EXCL);
    }
  fs.renameSync(p.stage, target);
  if (destinationHash(ctx, target) !== requestedHash)
    fail("DRIFT", "Destination changed during replacement; run recover");
  finish(ctx, journal);
  return {
    id: entry.id,
    outcome: "UPDATED",
    hash: requestedHash,
    retainedBackup: oldHash ? p.backup : null,
  };
}
export function recover(ctx: Context, dryRun: boolean): unknown {
  let journal = pending(ctx);
  if (!journal) return { outcome: "CURRENT", message: "No interrupted replacement" };
  const target = targetPath(ctx, journal.id);
  const nextHash = journal.next.deployed?.hash;
  if (
    !nextHash ||
    journal.next.candidate?.hash !== nextHash ||
    journal.next.approval?.hash !== nextHash ||
    journal.next.id !== journal.id
  )
    fail("STATE_INVALID", "Invalid replacement journal");
  getObject(ctx.home, nextHash);
  if (journal.version === 1 && exists(paths(ctx, journal.transaction, true).root)) {
    storage(ctx, false);
    if (exists(paths(ctx, journal.transaction).root))
      fail("STATE_INVALID", "Legacy relocation target already exists; preserve both");
    if (!dryRun) {
      storage(ctx, true);
      journal = { ...journal, version: 3, storage: storageRoot(ctx) };
      atomicJson(join(ctx.home, "transaction.json"), journal);
    }
  }
  if (journal.version === 2 || journal.version === 3) {
    if (journal.storage !== storageRoot(ctx))
      fail("STATE_INVALID", "Unexpected transaction storage");
    storage(ctx, false);
  }
  if (journal.version === 3) {
    const from = paths(ctx, journal.transaction, true).root;
    const to = paths(ctx, journal.transaction).root;
    if (exists(from) === exists(to))
      fail("STATE_INVALID", "Ambiguous legacy relocation; preserve both paths");
    if (!dryRun) {
      if (exists(from)) fs.renameSync(from, to);
      journal = { ...journal, version: 2 };
      atomicJson(join(ctx.home, "transaction.json"), journal);
    }
  }
  const p = paths(
    ctx,
    journal.transaction,
    journal.version === 1 ||
      (journal.version === 3 && exists(paths(ctx, journal.transaction, true).root)),
  );
  const current = destinationHash(ctx, target);
  if (current === nextHash) {
    if (!dryRun) finish(ctx, journal);
    return {
      outcome: dryRun ? "WOULD_COMPLETE" : "RECOVERED",
      id: journal.id,
      action: "complete deployment record",
    };
  }
  if (current === null && journal.oldHash && exists(p.backup)) {
    // A host write to the backup is retained and restored, never discarded.
    const backupHash = destinationHash(ctx, p.backup);
    if (!dryRun) {
      fs.renameSync(p.backup, target);
      fs.unlinkSync(join(ctx.home, "transaction.json"));
    }
    return {
      outcome: dryRun ? "WOULD_RESTORE" : "RECOVERED",
      id: journal.id,
      action: "restore previous directory",
      drift: backupHash !== journal.oldHash,
    };
  }
  if (current === journal.oldHash) {
    if (!dryRun) fs.unlinkSync(join(ctx.home, "transaction.json"));
    return {
      outcome: dryRun ? "WOULD_ABORT" : "RECOVERED",
      id: journal.id,
      action: "retain unchanged destination",
    };
  }
  return fail(
    "DRIFT",
    "Recovery found unknown destination bytes; preserve the transaction and reconcile manually",
  );
}
