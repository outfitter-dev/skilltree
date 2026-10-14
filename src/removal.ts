import * as fs from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  entrySchema,
  fail,
  lockSchema,
  manifestSchema,
  slug,
  type Entry,
  type Journal,
  type Lock,
} from "./model";
import { atomicJson, assertNoSymlinks, exists, readJson } from "./files";
import {
  destinationHash,
  expectedLive,
  paths,
  storage,
  storageRoot,
  targetPath,
} from "./deployment";
import {
  createLibrarySnapshot,
  directoryTree,
  libraryHash,
  readLibrarySnapshot,
  treeDigest,
  libraryPending,
} from "./library-backup";
import { load, pending, save, type Context } from "./state";
import { preflightLocal } from "./git";
import { ownershipSchema, rememberBackup, validateOwned } from "./ownership";
import { lockDescriptor } from "./lock-descriptor";
import { scratchRepairPending } from "./scratch-journal";

export interface RemovalOptions {
  dryRun?: boolean | undefined;
  source?: string | undefined;
  force?: boolean | undefined;
  all?: boolean | undefined;
}
type RemovalJournal = Extract<Journal, { version: 4 }>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const lockDigest = (value: Lock) => digest(lockSchema.parse(value));
const configuration = (ctx: Context) => digest(manifestSchema.parse(ctx.manifest));
function otherTransactions(ctx: Context): void {
  if (libraryPending(ctx) || scratchRepairPending(ctx.home))
    fail("RECOVERY_REQUIRED", "Complete library or scratch recovery before removal");
}

function writer(ctx: Context, dryRun: boolean): void {
  if (dryRun) return;
  if (ctx.manifest.lockBackend === "flock") {
    const fd = lockDescriptor();
    const file = assertNoSymlinks(
      join(
        ctx.runtime,
        ctx.manifest.runtimeVersion === 2
          ? "sync.lock"
          : (ctx.manifest.legacyLockName ?? "kernel.lock"),
      ),
    );
    if (fd === null || !exists(file))
      fail("LOCK_REQUIRED", "Removal requires the collection writer lock");
    const active = fs.fstatSync(fd),
      current = fs.statSync(file);
    if (active.ino !== current.ino || active.dev !== current.dev)
      fail("LOCK_REQUIRED", "Removal writer lock belongs to another domain");
  } else {
    const path = assertNoSymlinks(join(ctx.runtime, "lock", "owner.json"));
    if (!exists(path) || (readJson(path) as { pid?: unknown }).pid !== process.pid)
      fail("LOCK_REQUIRED", "Removal requires the collection writer lock");
  }
}
function state(ctx: Context, before: string, config: string): void {
  const current = load(ctx.home);
  if (lockDigest(current.lock) !== before || configuration(current) !== config)
    fail(
      "REMOVAL_STATE_CHANGED",
      "Collection ownership/configuration changed; retain removal data and reconcile",
    );
}
function basis(ctx: Context, entry: Entry): string {
  const source = ctx.lock.sources.find((item) => item.id === entry.source);
  if (!source) fail("STATE_INVALID", "Removal source ownership is missing");
  return digest({
    id: entry.id,
    source: entry.source,
    path: entry.path,
    name: entry.name,
    profiles: entry.profiles,
    upstream: entry.upstream,
    local: entry.local,
    deployed: entry.deployed,
    observed: entry.observed,
    deployedBase: entry.deployedBase,
    repository: source.repository,
    ref: source.ref,
    destination: ctx.manifest.destination,
    adapter: ctx.manifest.adapter,
    hostMetadata: ctx.manifest.hostMetadata ?? [],
  });
}
function removalHash(
  entry: Entry,
  value: Pick<NonNullable<Entry["removal"]>, "basis" | "expected" | "directory" | "retireSource">,
): string {
  return digest({
    version: 1,
    operation: "remove",
    id: entry.id,
    basis: value.basis,
    expected: value.expected,
    directory: value.directory,
    retireSource: value.retireSource,
  });
}
function preflight(ctx: Context, entry: Entry): { expected: string | null; directory: string } {
  if (entry.outcome === "CONFLICT" || entry.outcome === "DRIFT")
    fail(entry.outcome, `Reconcile ${entry.id} before staging or applying removal`);
  preflightLocal(ctx.home, entry.id, entry.local);
  const target = targetPath(ctx, entry.id),
    expected = expectedLive(entry);
  if (destinationHash(ctx, target) !== expected)
    fail(
      expected === null ? "COLLISION" : "DRIFT",
      `Removal destination differs from accepted ownership: ${entry.id}`,
    );
  return { expected, directory: treeDigest(directoryTree(ctx.home, target)) };
}
function plannedLock(lock: Lock, id: string, retireSource: boolean): Lock {
  const entry = lock.entries.find((item) => item.id === id);
  if (!entry) fail("STATE_INVALID", "Removal selection ownership is missing");
  const next = structuredClone(lock);
  next.entries = next.entries.filter((item) => item.id !== id);
  if (retireSource && !next.entries.some((item) => item.source === entry.source))
    next.sources = next.sources.filter((item) => item.id !== entry.source);
  return lockSchema.parse(next);
}
function withoutTarget(
  tree: ReturnType<typeof directoryTree>,
  id: string,
): ReturnType<typeof directoryTree> {
  return {
    ...tree,
    rows: Object.fromEntries(
      Object.entries(tree.rows).filter(([path]) => path !== id && !path.startsWith(id + "/")),
    ),
  };
}
function snapshotTarget(
  tree: ReturnType<typeof directoryTree>,
  id: string,
): ReturnType<typeof directoryTree> {
  const rows = Object.fromEntries(
    Object.entries(tree.rows)
      .filter(([path]) => path === id || path.startsWith(id + "/"))
      .map(([path, row]) => [path === id ? "" : path.slice(id.length + 1), row]),
  );
  return { exists: !!rows[""], rows };
}

export function stageRemovals(ctx: Context, ids: string[], options: RemovalOptions = {}): unknown {
  const dryRun = options.dryRun ?? false;
  writer(ctx, dryRun);
  const before = lockDigest(ctx.lock),
    config = configuration(ctx);
  state(ctx, before, config);
  otherTransactions(ctx);
  if (options.all && ids.length) fail("USAGE", "Choose explicit skills or --all, not both");
  if (pending(ctx))
    fail("RECOVERY_REQUIRED", "Recover the interrupted transaction before staging removals");
  const source = options.source
    ? ctx.lock.sources.find((item) => item.id === slug.parse(options.source))
    : undefined;
  if (options.source && !source) fail("NOT_FOUND", "Unknown removal source");
  const sourceRemoval = !!source && ids.length === 0;
  const dependents = source ? ctx.lock.entries.filter((entry) => entry.source === source.id) : [];
  if (sourceRemoval && dependents.length && !options.force)
    fail(
      "SOURCE_SELECTED",
      "Source still has selected skills; --force only stages their guarded removals",
    );
  if (sourceRemoval && !dependents.length) {
    directoryTree(ctx.home, ctx.manifest.destination);
    if (dryRun) return { outcome: "WOULD_REMOVE_SOURCE", source: source!.id };
    const recoveryPoint = createLibrarySnapshot(ctx, "before removing unused source " + source!.id);
    state(ctx, before, configuration(ctx));
    if (libraryHash(ctx) !== recoveryPoint.hash)
      fail("BACKUP_CHANGED", "Library changed after source-removal backup");
    writer(ctx, false);
    ctx.lock.sources = ctx.lock.sources.filter((item) => item.id !== source!.id);
    save(ctx);
    state(ctx, lockDigest(ctx.lock), configuration(ctx));
    return { outcome: "SOURCE_REMOVED", source: source!.id, recoveryPoint: recoveryPoint.id };
  }
  const chosen = sourceRemoval
    ? dependents
    : options.all
      ? ctx.lock.entries
      : ids.map((id) => {
          const entry = ctx.lock.entries.find((item) => item.id === slug.parse(id));
          if (!entry || (source && entry.source !== source.id))
            fail("NOT_FOUND", `Unknown removal selection ${id}`);
          return entry;
        });
  if (!chosen.length) fail("USAGE", "Choose selected skills or an unused source to remove");
  const unique = [...new Map(chosen.map((entry) => [entry.id, entry])).values()];
  const staged = unique.map((entry): Entry => {
    const current = preflight(ctx, entry),
      content = { ...current, basis: basis(ctx, entry), retireSource: sourceRemoval };
    const removal = {
      ...content,
      hash: removalHash(entry, content),
      previous: entry.removal?.previous ?? {
        candidate: entry.candidate,
        approval: entry.approval,
        outcome: entry.outcome,
        reasons: entry.reasons,
      },
    };
    return {
      ...entry,
      removal,
      candidate: { hash: removal.hash, revision: entry.upstream.revision },
      approval: null,
      outcome: "HELD",
      reasons: [
        "Exact removal candidate approval required; accepted content and histories remain retained",
      ],
    };
  });
  state(ctx, before, config);
  if (!dryRun) {
    writer(ctx, false);
    const byId = new Map(staged.map((entry) => [entry.id, entry]));
    ctx.lock.entries = ctx.lock.entries.map((entry) => byId.get(entry.id) ?? entry);
    save(ctx);
    state(ctx, lockDigest(ctx.lock), config);
  }
  return {
    outcome: dryRun ? "WOULD_STAGE_REMOVALS" : "REMOVALS_STAGED",
    entries: staged,
    source: source?.id ?? null,
  };
}

function checkedJournal(
  ctx: Context,
  journal: RemovalJournal,
): { point: ReturnType<typeof readLibrarySnapshot>; beforeEntry: Entry } {
  if (
    journal.collection !== ctx.home ||
    journal.destination !== ctx.manifest.destination ||
    journal.storage !== storageRoot(ctx)
  )
    fail("STATE_INVALID", "Removal journal ownership/storage differs");
  storage(ctx, false);
  const point = readLibrarySnapshot(ctx, journal.recoveryPoint);
  const beforeEntry = point.lock.entries.find((item) => item.id === journal.id);
  const removal = beforeEntry?.removal;
  if (
    !beforeEntry ||
    !removal ||
    digest(entrySchema.parse(beforeEntry)) !== digest(entrySchema.parse(journal.next)) ||
    lockDigest(point.lock) !== journal.before ||
    journal.next.candidate?.hash !== removal.hash ||
    journal.next.approval?.hash !== removal.hash ||
    journal.oldHash !== removal.expected ||
    journal.directory !== removal.directory ||
    treeDigest(snapshotTarget(point.tree, journal.id)) !== removal.directory ||
    lockDigest(plannedLock(point.lock, journal.id, removal.retireSource)) !==
      lockDigest(journal.nextLock) ||
    treeDigest(withoutTarget(point.tree, journal.id)) !== journal.after
  )
    fail(
      "STATE_INVALID",
      "Removal journal does not match its verified recovery point and ownership",
    );
  const recorded = { ...ctx, lock: point.lock };
  if (
    removal.basis !== basis(recorded, beforeEntry) ||
    removal.hash !==
      removalHash(beforeEntry, {
        basis: removal.basis,
        expected: removal.expected,
        directory: removal.directory,
        retireSource: removal.retireSource,
      })
  )
    fail("STALE_REMOVAL", "Removal approval does not bind the recorded content");
  if (configuration(ctx) !== journal.configuration)
    fail("REMOVAL_STATE_CHANGED", "Removal configuration changed");
  return { point, beforeEntry };
}
function transaction(ctx: Context, journal: RemovalJournal): ReturnType<typeof paths> {
  const p = paths(ctx, journal.transaction);
  const owner = ownershipSchema.parse(readJson(join(p.root, "owner.json")));
  if (owner.root !== p.root || owner.collection !== ctx.home)
    fail("OWNERSHIP_HELD", "Removal transaction storage belongs to another collection");
  if (fs.readdirSync(p.root).some((name) => !["owner.json", "backup"].includes(name)))
    fail("OWNERSHIP_HELD", "Unknown files in removal transaction; preserve and reconcile");
  if (Object.keys(owner.files).length && validateOwned(p.root, owner, ["owner.json"]).length)
    fail("OWNERSHIP_HELD", "Retained removal backup differs from its ownership record");
  return p;
}
function complete(ctx: Context, journal: RemovalJournal): void {
  writer(ctx, false);
  checkedJournal(ctx, journal);
  const p = transaction(ctx, journal);
  if (exists(targetPath(ctx, journal.id)) || libraryHash(ctx) !== journal.after)
    fail("DRIFT", "Removal destination changed; preserve the retained backup");
  if (journal.oldHash !== null) {
    if (
      !exists(p.backup) ||
      treeDigest(directoryTree(ctx.home, p.backup)) !== journal.directory ||
      destinationHash(ctx, p.backup) !== journal.oldHash
    )
      fail("DRIFT", "Retained removal backup changed; preserve and reconcile");
  } else if (exists(p.backup))
    fail("OWNERSHIP_HELD", "Unexpected backup for an undeployed selection");
  preflightLocal(ctx.home, journal.id, journal.next.local);
  const disk = lockDigest(load(ctx.home).lock),
    after = lockDigest(journal.nextLock);
  if (disk !== journal.before && disk !== after)
    fail("REMOVAL_STATE_CHANGED", "Collection changed during removal");
  state(ctx, disk, journal.configuration);
  rememberBackup(p.root, undefined, ctx.home);
  if (
    libraryHash(ctx) !== journal.after ||
    (journal.oldHash !== null &&
      treeDigest(directoryTree(ctx.home, p.backup)) !== journal.directory)
  )
    fail("DRIFT", "Removal bytes changed during ownership recording");
  state(ctx, disk, journal.configuration);
  writer(ctx, false);
  ctx.lock = journal.nextLock;
  save(ctx);
  state(ctx, after, journal.configuration);
  fs.unlinkSync(join(ctx.home, "transaction.json"));
}

export function applyRemoval(
  ctx: Context,
  entry: Entry,
  requestedHash: string,
  dryRun: boolean,
  afterBackup?: () => void,
): unknown {
  writer(ctx, dryRun);
  const config = configuration(ctx);
  let before = lockDigest(ctx.lock);
  if (dryRun) {
    const durable = load(ctx.home),
      accepted = durable.lock.entries.find((item) => item.id === entry.id);
    if (!accepted) fail("REMOVAL_STATE_CHANGED", "Removal selection ownership changed");
    if (accepted.outcome === "CONFLICT" || accepted.outcome === "DRIFT")
      fail(accepted.outcome, `Reconcile ${entry.id} before applying removal`);
    if (entry.outcome !== accepted.outcome && entry.outcome !== "STAGED")
      fail("REMOVAL_STATE_CHANGED", "Only prospective approval may change in a removal preview");
    // Combined apply/reason previews may supply only a prospective approval.
    // Every content, ownership and removal field must still equal durable state.
    const comparable = {
      ...ctx.lock,
      entries: ctx.lock.entries.map((item) =>
        item.id === entry.id
          ? { ...item, approval: accepted.approval, outcome: accepted.outcome }
          : item,
      ),
    };
    before = lockDigest(durable.lock);
    if (lockDigest(comparable) !== before)
      fail("REMOVAL_STATE_CHANGED", "Removal selection ownership changed");
  }
  state(ctx, before, config);
  otherTransactions(ctx);
  if (pending(ctx))
    fail("RECOVERY_REQUIRED", "Recover the interrupted transaction before applying removal");
  const accepted = ctx.lock.entries.find((item) => item.id === entry.id);
  if (!accepted || digest(entrySchema.parse(entry)) !== digest(entrySchema.parse(accepted)))
    fail("REMOVAL_STATE_CHANGED", "Removal selection ownership changed");
  const removal = entry.removal;
  if (!removal || requestedHash !== removal.hash || entry.candidate?.hash !== requestedHash)
    fail("STALE_CANDIDATE", "Removal must name its current exact candidate hash");
  if (entry.approval?.hash !== requestedHash || !entry.approval.reason.trim())
    fail("HELD", "Approve the exact removal hash with a reason before applying");
  const current = preflight(ctx, entry),
    content = { ...current, basis: basis(ctx, entry), retireSource: removal.retireSource };
  if (removalHash(entry, content) !== requestedHash)
    fail("STALE_REMOVAL", "Removal content or ownership changed; stage and review again");
  storage(ctx, false);
  if (dryRun) {
    directoryTree(ctx.home, ctx.manifest.destination);
    state(ctx, before, config);
    return { outcome: "WOULD_REMOVE", id: entry.id, hash: requestedHash };
  }
  const recoveryPoint = createLibrarySnapshot(ctx, "before removing " + entry.id);
  const journal: RemovalJournal = {
    version: 4,
    transaction: randomUUID(),
    id: entry.id,
    oldHash: current.expected,
    next: entry,
    collection: ctx.home,
    destination: ctx.manifest.destination,
    storage: storageRoot(ctx),
    before,
    configuration: configuration(ctx),
    nextLock: plannedLock(ctx.lock, entry.id, removal.retireSource),
    recoveryPoint: recoveryPoint.id,
    directory: current.directory,
    after: treeDigest(withoutTarget(recoveryPoint.tree, entry.id)),
  };
  state(ctx, before, journal.configuration);
  checkedJournal(ctx, journal);
  storage(ctx, true);
  const p = paths(ctx, journal.transaction);
  fs.mkdirSync(p.root, { mode: 0o700 });
  rememberBackup(p.root, undefined, ctx.home);
  writer(ctx, false);
  atomicJson(join(ctx.home, "transaction.json"), journal);
  state(ctx, before, journal.configuration);
  if (
    libraryHash(ctx) !== recoveryPoint.hash ||
    treeDigest(directoryTree(ctx.home, targetPath(ctx, entry.id))) !== current.directory
  )
    fail("BACKUP_CHANGED", "Library changed after removal backup; recover before proceeding");
  transaction(ctx, journal);
  if (exists(p.backup)) fail("OWNERSHIP_HELD", "Removal backup path is already occupied");
  writer(ctx, false);
  if (current.expected !== null) fs.renameSync(targetPath(ctx, entry.id), p.backup);
  afterBackup?.();
  complete(ctx, journal);
  return {
    outcome: "REMOVED",
    id: entry.id,
    hash: requestedHash,
    retainedBackup: current.expected === null ? null : p.backup,
    recoveryPoint: recoveryPoint.id,
  };
}

export function recoverRemoval(ctx: Context, dryRun: boolean): unknown {
  writer(ctx, dryRun);
  otherTransactions(ctx);
  const journal = pending(ctx);
  if (!journal || journal.version !== 4)
    fail("STATE_INVALID", "No guarded removal transaction exists");
  const { point } = checkedJournal(ctx, journal),
    p = transaction(ctx, journal);
  const disk = lockDigest(load(ctx.home).lock),
    after = lockDigest(journal.nextLock);
  if (disk !== journal.before && disk !== after)
    fail("REMOVAL_STATE_CHANGED", "Collection changed since removal intent");
  state(ctx, disk, journal.configuration);
  const target = targetPath(ctx, journal.id);
  if (!exists(target)) {
    if (
      journal.oldHash !== null &&
      (!exists(p.backup) || treeDigest(directoryTree(ctx.home, p.backup)) !== journal.directory)
    )
      fail("DRIFT", "Retained removal backup is missing or changed");
    if (journal.oldHash === null && exists(p.backup))
      fail("OWNERSHIP_HELD", "Unexpected removal backup");
    if (libraryHash(ctx) !== journal.after)
      fail("DRIFT", "Library changed during interrupted removal");
    preflightLocal(ctx.home, journal.id, journal.next.local);
    if (!dryRun) complete(ctx, journal);
    return {
      outcome: dryRun ? "WOULD_COMPLETE" : "RECOVERED",
      id: journal.id,
      action: "complete exact approved removal",
      recoveryPoint: point.id,
    };
  }
  if (
    disk === journal.before &&
    !exists(p.backup) &&
    libraryHash(ctx) === point.hash &&
    treeDigest(directoryTree(ctx.home, target)) === journal.directory &&
    destinationHash(ctx, target) === journal.oldHash
  ) {
    state(ctx, disk, journal.configuration);
    if (!dryRun) {
      writer(ctx, false);
      fs.unlinkSync(join(ctx.home, "transaction.json"));
    }
    return {
      outcome: dryRun ? "WOULD_ABORT" : "RECOVERED",
      id: journal.id,
      action: "retain unchanged destination",
    };
  }
  return fail(
    "DRIFT",
    "Unknown removal destination or backup bytes; preserve and reconcile manually",
  );
}
