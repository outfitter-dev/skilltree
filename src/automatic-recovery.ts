import { createHash } from "node:crypto";
import { entrySchema, fail, lockSchema, type Entry, type Journal } from "./model";
import { getObject, treeHash } from "./files";
import { committedTree, git, localPath, preflightLocal } from "./git";
import { readArchive } from "./archives";
import { expectedLive } from "./deployment";
import { readLibrarySnapshot } from "./library-backup";
import { type Context } from "./state";

type ReplacementJournal = Exclude<Journal, { version: 4 }>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameEntry = (left: Entry, right: Entry) =>
  JSON.stringify(entrySchema.parse(left)) === JSON.stringify(entrySchema.parse(right));
const sameLock = (left: Context["lock"], right: Context["lock"]) =>
  JSON.stringify(lockSchema.parse(left)) === JSON.stringify(lockSchema.parse(right));
function held(message: string): never {
  return fail("RECOVERY_REQUIRED", message + "; inspect recover --dry-run");
}

function localResult(ctx: Context, before: Entry, next: Entry): Entry["local"] {
  if (!before.local) {
    if (next.local) held("Replacement added unapproved local ownership");
    preflightLocal(ctx.home, before.id, null);
    return null;
  }
  const local = next.local,
    candidate = before.candidate!;
  if (
    !local ||
    local.hash !== candidate.hash ||
    local.base !== before.upstream.hash ||
    local.checkout !== before.local.checkout ||
    !local.archive
  )
    held("Replacement local history differs from the approved content or checkout");
  preflightLocal(ctx.home, before.id, local);
  const root = localPath(ctx.home, before.id, local);
  if (
    git(root, ["rev-parse", "HEAD"]) !== local.commit ||
    treeHash(committedTree(root, before.local.commit)) !== before.local.hash ||
    treeHash(committedTree(root, local.commit)) !== candidate.hash
  )
    held("Replacement local commits differ from accepted and approved content");
  try {
    git(root, ["merge-base", "--is-ancestor", before.local.commit, local.commit]);
  } catch {
    held("Replacement local history does not retain the accepted commit");
  }
  const archive = readArchive(ctx.home, local.archive);
  if (
    archive.kind !== "local" ||
    archive.id !== before.id ||
    archive.revision !== local.commit ||
    archive.repository !== null ||
    // New apply journals archive their generated history as verified Git objects.
    // A legacy bundle cannot prove this transition without explicit recovery.
    archive.version !== 2 ||
    !archive.objects[before.local.commit] ||
    !archive.objects[local.commit]
  )
    held("Replacement archive does not retain the required local provenance");
  return local;
}

export function validateAutomaticReplacement(ctx: Context, journal: ReplacementJournal): void {
  if (!journal.recoveryPoint || journal.configuration !== digest(ctx.manifest))
    held("Interrupted transaction lacks complete backup/configuration evidence");
  const point = readLibrarySnapshot(ctx, journal.recoveryPoint),
    before = point.lock.entries.find((entry) => entry.id === journal.id);
  if (
    !before ||
    before.removal ||
    before.outcome === "CONFLICT" ||
    before.outcome === "DRIFT" ||
    !before.candidate ||
    before.approval?.hash !== before.candidate.hash ||
    !before.approval.reason.trim() ||
    journal.oldHash !== expectedLive(before)
  )
    held("Backup lacks exact approved replacement ownership");
  getObject(ctx.home, before.candidate.hash);
  const expected: Entry = {
    ...before,
    deployed: before.candidate,
    deployedBase: before.upstream.hash,
    observed: null,
    outcome: "UPDATED",
    reasons: [],
    local: localResult(ctx, before, journal.next),
  };
  if (!sameEntry(journal.next, expected))
    held("Replacement result differs from the verified approved intent");
  const after = structuredClone(point.lock),
    index = after.entries.findIndex((entry) => entry.id === journal.id);
  after.entries[index] = expected;
  if (!sameLock(ctx.lock, point.lock) && !sameLock(ctx.lock, after))
    held("Collection ownership changed after transaction intent");
}
