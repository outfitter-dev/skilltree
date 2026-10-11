import * as fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fail, type Entry, type Journal } from "./model";
import { atomicJson, assertNoSymlinks, exists, getObject, liveHash, writeTree } from "./files";
import { pending, save, type Context } from "./state";
import { preflightLocal, recordLocal } from "./git";

export function expectedLive(entry: Entry): string | null {
  return entry.observed ?? entry.deployed?.hash ?? null;
}
export function targetPath(ctx: Context, id: string): string {
  return assertNoSymlinks(join(ctx.manifest.destination, id));
}
export function paths(ctx: Context, transaction: string) {
  const root = assertNoSymlinks(
    join(ctx.manifest.destination, `.skilltree-transaction-${transaction}`),
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
  if (liveHash(target) !== oldHash)
    fail(
      oldHash ? "DRIFT" : "COLLISION",
      "Destination differs from the accepted ownership baseline; capture or reconcile it first",
    );
  preflightLocal(ctx.home, entry.id, entry.local);
  if (entry.deployed?.hash === requestedHash && !entry.observed)
    return { id: entry.id, outcome: "CURRENT", hash: requestedHash };
  if (dryRun) return { id: entry.id, outcome: "WOULD_APPLY", hash: requestedHash };
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
    };
  const transaction = randomUUID();
  const p = paths(ctx, transaction);
  fs.mkdirSync(p.root);
  const journal: Journal = { version: 1, transaction, id: entry.id, oldHash, next };
  atomicJson(join(ctx.home, "transaction.json"), journal);
  writeTree(p.stage, tree);
  if (liveHash(p.stage) !== requestedHash) fail("STAGING_CHANGED", "Staged file set changed");
  if (liveHash(target) !== oldHash)
    fail("DRIFT", "Destination changed before replacement; run recover");
  if (oldHash !== null) fs.renameSync(target, p.backup);
  afterBackup?.();
  if (oldHash !== null && liveHash(p.backup) !== oldHash)
    fail("DRIFT", "Concurrent write changed the retained backup; run recover");
  if (exists(target)) fail("DRIFT", "Destination reappeared during replacement; run recover");
  fs.renameSync(p.stage, target);
  if (liveHash(target) !== requestedHash)
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
  const journal = pending(ctx);
  if (!journal) return { outcome: "CURRENT", message: "No interrupted replacement" };
  const p = paths(ctx, journal.transaction);
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
  const current = liveHash(target);
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
    const backupHash = liveHash(p.backup);
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
