import { recoverScratch } from "./scratch-recovery";
import { readScratchJournal, scratchRepairPending } from "./scratch-journal";
import { compactLibrary } from "./library-maintenance";
import { checkedPython, type PythonIdentity } from "./filesystem-capabilities";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  fail,
  slug,
  skillPath,
  hash,
  manifestSchema,
  SkilltreeError,
  type Entry,
  type Source,
} from "./model";
import {
  atomicJson,
  assertNoSymlinks,
  exists,
  getObject,
  inside,
  putObject,
  readTree,
  treeHash,
  triage,
} from "./files";
import {
  acquire,
  mergeTrees,
  recordLocal,
  repository,
  preflightLocal,
  preflightSource,
  sourcePath,
} from "./git";
import { discover, metadataTree, selectedHold, type Discovery, type Hold } from "./discovery";
import { load, pending, save, unlock, withLock, runtimePath, type Context } from "./state";
import { destinationHash, applyEntry, expectedLive, recover, targetPath } from "./deployment";
import {
  materialize,
  retireSource,
  archiveRepository,
  archiveAccepted,
  restoreMaterializations,
  readArchive,
} from "./archives";
import { localPath } from "./git";
import {
  configure,
  migrateStorage,
  compact,
  sourceFailure,
  stageScratch,
  checkpointScratch,
} from "./maintenance";
import {
  createLibrarySnapshot,
  directoryTree,
  libraryBackups,
  libraryPending,
  revertLibrary,
  recoverLibrary,
} from "./library-backup";
import { probeSkills } from "./skills-adapter";
import { checkedId } from "./command-input";
import {
  chooseSkills,
  qualifiedRepository,
  selectedIds,
  skillId,
  sameRepository,
  sourceId,
} from "./source-selection";
import { applyRemoval, recoverRemoval, stageRemovals } from "./removal";
import { validateAutomaticReplacement } from "./automatic-recovery";

export interface Options {
  skills?: string[];
  all?: boolean;
  yes?: boolean;
  list?: boolean;
  fullDepth?: boolean;
  force?: boolean;
  keepCurrent?: boolean;
  quietHost?: boolean;
  retainedDirectories?: boolean;
  backupScratch?: boolean;
  snapshot?: string;
  expect?: string;
  dryRun?: boolean;
  source?: string;
  ref?: string;
  path?: string;
  id?: string;
  profile?: string;
  install?: boolean;
  reason?: string;
  hash?: string;
  destination?: string;
  exclusive?: boolean;
  primary?: string;
  gardener?: string;
  unlock?: boolean;
  npx?: string;
  adapter?: "filesystem" | "grok";
  transactionStorage?: string;
  runtimeRoot?: string;
  caches?: boolean;
  scratch?: boolean;
  retainBackups?: number;
  hostMetadata?: boolean;
  lockBackend?: "mkdir" | "flock";
}
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) fail("USAGE", `Missing --${name}`);
  return value;
}
function selection(ctx: Context, id: string): Entry {
  const entry = ctx.lock.entries.find((e) => e.id === id);
  if (!entry) fail("NOT_FOUND", `Unknown selection ${id}`);
  return entry;
}
function sourceRoot(ctx: Context, item: Source): string {
  const root = sourcePath(ctx.home, item);
  preflightSource(root, item.repository, item.revision);
  return root;
}
function publishSource(home: string, item: { source: Source; root: string }): Source {
  const source: Source = { ...item.source, checkout: randomUUID() };
  const root = assertNoSymlinks(sourcePath(home, source));
  // New generations are never reused or deleted, even after interruption.
  // Only atomic lock publication changes which generation is accepted.
  fs.mkdirSync(join(home, "repos"), { recursive: true });
  source.archive = archiveRepository(
    home,
    item.root,
    "source",
    source.id,
    source.revision,
    source.repository,
  );
  materialize(home, source.archive, "source", source.id, source.revision, source.repository, root);
  preflightSource(root, source.repository, source.revision);
  return source;
}
function source(ctx: Context, id: string): Source {
  const item = ctx.lock.sources.find((s) => s.id === id);
  if (!item) fail("NOT_FOUND", `Unknown source ${id}`);
  return item;
}
export function eventsFor(result: unknown): unknown[] {
  const value = result as {
    sources?: { id: string; outcome: string; code?: string; holds?: Hold[] }[];
    source?: string;
    holds?: Hold[];
    entry?: Entry;
    entries?: Entry[];
    outcome?: string;
    id?: string;
  };
  const events: unknown[] = [];
  function held(holds: Hold[], source: string | undefined) {
    for (const hold of holds)
      events.push({
        version: 1,
        type: hold.scope === "skill" ? "skill.held" : "projection.held",
        source,
        ...hold,
        action: "reconcile this path; unsupported content remains excluded",
      });
  }
  held(value.holds ?? [], value.source);
  for (const source of Array.isArray(value.sources) ? value.sources : [])
    if (source.outcome === "ERROR")
      events.push({
        version: 1,
        type: "source.error",
        source: source.id,
        code: source.code,
        action: "reconcile source and retry",
      });
    else held(source.holds ?? [], source.id);
  for (const entry of value.entry
    ? [value.entry]
    : Array.isArray(value.entries)
      ? value.entries
      : [])
    if (["HELD", "CONFLICT", "DRIFT"].includes(entry.outcome))
      events.push({
        version: 1,
        type: `skill.${entry.outcome.toLowerCase()}`,
        id: entry.id,
        source: entry.source,
        path: entry.path,
        reasons: entry.reasons,
        candidate: entry.candidate?.hash ?? null,
        action: "review; approval and apply remain explicit",
      });
  return events;
}
function report(ctx: Context, command: string, result: unknown): unknown {
  const runId = randomUUID();
  const events = eventsFor(result);
  atomicJson(join(ctx.home, "reports", `${runId}.json`), { runId, command, result, events });
  return { runId, result, events };
}
function scratch<T>(ctx: Context, work: (root: string) => T): T {
  const root = stageScratch(ctx);
  try {
    return work(root);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
}
export function initialize(home: string, options: Options): unknown {
  home = assertNoSymlinks(home);
  const destination = assertNoSymlinks(required(options.destination, "dest"));
  if (!options.exclusive)
    fail(
      "USAGE",
      "Filesystem adapter requires --exclusive-dest to acknowledge coordinated destination access",
    );
  if (inside(home, destination) || inside(destination, home))
    fail("PATH_OVERLAP", "State and destination must be separate");
  if (exists(home)) fail("EXISTS", "State directory already exists; refusing to overwrite");
  const manifest = manifestSchema.parse({
    version: 1,
    destination,
    adapter: options.adapter ?? "filesystem",
    transactionStorage: options.transactionStorage,
    runtimeRoot: options.runtimeRoot,
    runtimeVersion: 2,
    libraryRecoveryVersion: 1,
    legacyRuntime: options.runtimeRoot ? undefined : runtimePath(destination),
    legacyLockName: options.runtimeRoot ? undefined : "kernel.lock",
    hostMetadata:
      options.hostMetadata || options.adapter === "grok" ? ["workflow.md", "runs.json"] : [],
    lockBackend: options.lockBackend ?? (process.platform === "linux" ? "flock" : "mkdir"),
    exclusiveDestination: true,
    gardener: options.gardener ?? "gardener",
    primary: options.primary ?? null,
    policy: "manual",
  });
  if (!options.dryRun) {
    fs.mkdirSync(join(home, ".."), { recursive: true });
    fs.mkdirSync(home);
    fs.mkdirSync(destination, { recursive: true });
    atomicJson(join(home, "skilltree.json"), manifest);
    atomicJson(join(home, "skilltree.lock"), { version: 1, sources: [], entries: [] });
  }
  return { outcome: options.dryRun ? "WOULD_INIT" : "INITIALIZED", manifest };
}
function stage(
  ctx: Context,
  entry: Entry,
  acquired: Source,
  root: string,
  dryRun: boolean,
  scratchRoot: string,
  discovery: Discovery,
): Entry {
  const target = targetPath(ctx, entry.id);
  let observed: string | null;
  try {
    observed = destinationHash(ctx, target);
  } catch {
    return {
      ...entry,
      candidate: null,
      outcome: "HELD",
      reasons: [
        "Destination metadata/tree is unsupported; configure explicit host ownership or reconcile this skill",
      ],
    };
  }
  if (observed !== expectedLive(entry))
    return {
      ...entry,
      candidate: null,
      outcome: "DRIFT",
      reasons: ["Library differs from accepted baseline; capture local changes before sync"],
    };
  if (entry.removal) return entry;
  const hold = selectedHold(discovery, entry.path, true);
  if (hold)
    return {
      ...entry,
      candidate: null,
      outcome: "HELD",
      reasons: [`${hold.code}: ${hold.path}: ${hold.message}`],
    };
  const skill = discovery.skills.find((s) => s.path === entry.path);
  if (!skill)
    return {
      ...entry,
      candidate: null,
      outcome: "HELD",
      reasons: [
        "Selected upstream skill was removed or renamed; deliberate reconciliation required",
      ],
    };
  if (skill.name !== entry.name)
    return {
      ...entry,
      candidate: null,
      outcome: "HELD",
      reasons: ["Selected upstream skill identity changed"],
    };
  const upstreamTree = readTree(join(root, entry.path), entry.path === ".");
  let candidateTree = upstreamTree;
  if (entry.local) {
    const merged = mergeTrees(
      getObject(ctx.home, entry.local.base),
      getObject(ctx.home, entry.local.hash),
      upstreamTree,
      scratchRoot,
    );
    if (!merged.tree)
      return {
        ...entry,
        candidate: null,
        outcome: "CONFLICT",
        reasons: merged.conflicts.map((p) => `Conflicting local/upstream changes: ${p}`),
      };
    candidateTree = merged.tree;
  }
  try {
    metadataTree(candidateTree);
  } catch (error) {
    if (!(error instanceof SkilltreeError)) throw error;
    discovery.holds.push({
      path: entry.path,
      scope: "skill",
      code: error.code,
      message: error.message,
    });
    return {
      ...entry,
      candidate: null,
      outcome: "HELD",
      reasons: [`${error.code}: ${entry.path}: ${error.message}`],
    };
  }
  const upstreamHash = treeHash(upstreamTree);
  const candidateHash = treeHash(candidateTree);
  if (!dryRun) {
    putObject(ctx.home, upstreamTree);
    putObject(ctx.home, candidateTree);
  }
  const reasons = triage(
    entry.deployed ? getObject(ctx.home, entry.deployed.hash) : null,
    candidateTree,
  );
  const approved = entry.approval?.hash === candidateHash;
  if (!approved && !(entry.deployed?.hash === candidateHash && !entry.observed))
    reasons.unshift("Exact candidate approval required");
  return {
    ...entry,
    upstream: { hash: upstreamHash, revision: acquired.revision },
    candidate: { hash: candidateHash, revision: acquired.revision },
    outcome:
      entry.deployed?.hash === candidateHash && !entry.observed
        ? "CURRENT"
        : approved
          ? "STAGED"
          : "HELD",
    reasons,
  };
}
export function execute(
  home: string,
  command: string,
  args: string[],
  options: Options = {},
): unknown {
  const dryRun = options.dryRun ?? false;
  if (command === "init" || command === "setup") return initialize(home, options);
  if (command === "add" && options.list) {
    const query = qualifiedRepository(args[0] ?? fail("USAGE", "add requires a Git source"));
    const repo = repository(query.repository);
    const id = options.source ? checkedId(options.source, "Source ID") : sourceId(repo);
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skilltree-inventory-")));
    try {
      const acquired = acquire(root, id, repo, options.ref ?? "HEAD");
      const inventory = discover(join(root, "repos", id), options.fullDepth);
      return {
        outcome: inventory.holds.length ? (inventory.skills.length ? "PARTIAL" : "ERROR") : "OK",
        source: acquired,
        ...inventory,
        events: eventsFor({ source: id, holds: inventory.holds }),
      };
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
  const ctx = load(home);
  if (command === "backups") return libraryBackups(ctx);
  if (command === "list" || command === "status" || command === "verify") {
    const rows = ctx.lock.entries
      .filter((e) => !options.profile || e.profiles.includes(options.profile))
      .map((entry) => {
        let actual: string | null;
        try {
          actual = destinationHash(ctx, targetPath(ctx, entry.id));
        } catch (error) {
          return {
            ...entry,
            actual: null,
            drift: true,
            problem: error instanceof Error ? error.message : "Unreadable destination",
          };
        }
        return { ...entry, actual, drift: actual !== expectedLive(entry) };
      });
    return {
      outcome: rows.some((e) => e.drift)
        ? "DRIFT"
        : command === "verify"
          ? "CURRENT"
          : rows.some((e) => e.outcome === "CONFLICT")
            ? "CONFLICT"
            : rows.some((e) => e.outcome === "HELD")
              ? "HELD"
              : rows.some((e) => e.outcome === "STAGED")
                ? "STAGED"
                : "CURRENT",
      pending: pending(ctx) !== null || libraryPending(ctx),
      entries: rows,
    };
  }
  if (command === "inventory") {
    const s = source(ctx, args[0] ?? required(options.source, "source"));
    const inventory = discover(sourceRoot(ctx, s), options.fullDepth ?? s.fullDepth);
    return {
      outcome: inventory.holds.length ? (inventory.skills.length ? "PARTIAL" : "ERROR") : "OK",
      source: s,
      ...inventory,
      events: eventsFor({ source: s.id, holds: inventory.holds }),
    };
  }
  if (command === "doctor") {
    const issues: string[] = [];
    const warnings: string[] = [];
    let metadataInspector: PythonIdentity | { backend: string } | null =
      process.platform === "linux" ? null : { backend: "macOS xattr/ls" };
    if (process.platform === "linux")
      try {
        metadataInspector = checkedPython();
      } catch (error) {
        issues.push(error instanceof Error ? error.message : "Python interpreter unavailable");
      }
    try {
      execFileSync("git", ["--version"], { stdio: "pipe" });
    } catch {
      issues.push("Git executable unavailable");
    }
    for (const path of [ctx.home, ctx.manifest.destination])
      try {
        fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        issues.push(`Path lacks read/write access: ${path}`);
      }
    if (exists(join(ctx.runtime, "lock")))
      issues.push("Runtime lock exists; use recover --unlock only after owner exits");
    if (libraryPending(ctx))
      issues.push("Interrupted whole-directory restoration; run recover --dry-run");
    if (pending(ctx)) issues.push("Interrupted replacement; run recover");
    try {
      directoryTree(ctx.home, ctx.manifest.destination);
    } catch (error) {
      issues.push(
        `Complete backup unavailable: ${error instanceof Error ? error.message : "Metadata inspection failed"}`,
      );
    }
    const scratchStatus = readScratchJournal(ctx.home);
    if (scratchRepairPending(ctx.home))
      issues.push("Interrupted scratch journal repair; run recover --scratch --dry-run");
    if (scratchStatus.capacity.warning)
      warnings.push(
        "Scratch journal near capacity; inspect recover --scratch --dry-run before another backup",
      );
    for (const preserved of scratchStatus.preserved)
      warnings.push(`Sealed scratch journal preserved: ${preserved.root}: ${preserved.reason}`);
    const retainedDirectories = compactLibrary(ctx, { retainedDirectories: true, dryRun: true });
    for (const item of retainedDirectories.held)
      issues.push(`Held retained directory: ${item.root}: ${item.reason}`);
    const backupScratch = compactLibrary(ctx, { backupScratch: true, dryRun: true });
    for (const item of backupScratch.held)
      issues.push(`Held backup scratch: ${item.root}: ${item.reason}`);
    if (backupScratch.candidates.length)
      warnings.push(
        "Verified abandoned backup scratch is available; inspect compact --backup-scratch --dry-run",
      );
    for (const name of exists(ctx.manifest.destination)
      ? fs.readdirSync(ctx.manifest.destination)
      : [])
      if (name.startsWith(".skilltree-transaction-")) {
        const root = join(ctx.manifest.destination, name);
        if (fs.readdirSync(root).length > 0)
          issues.push(
            `Legacy catalog-visible storage remains: ${root}; run migrate-storage --dry-run and reconcile recognized ownership`,
          );
        else
          warnings.push(
            "Empty or unrecognized legacy folder retained; inspect without deleting unknown work",
          );
      }
    for (const item of ctx.lock.sources) {
      try {
        sourceRoot(ctx, item);
      } catch {
        let suggestion = "";
        try {
          if (item.archive) {
            const archive = readArchive(ctx.home, item.archive);
            if (
              archive.kind === "source" &&
              archive.id === item.id &&
              archive.revision === item.revision &&
              archive.repository === item.repository
            )
              suggestion = "; valid archive available: run restore --dry-run";
          }
        } catch {
          /* Corrupt archives must not be recommended. */
        }
        issues.push(
          `${item.id}: acquired source missing, dirty, or at an unexpected revision${suggestion}`,
        );
      }
    }
    for (const entry of ctx.lock.entries) {
      try {
        preflightLocal(ctx.home, entry.id, entry.local);
        for (const digest of [
          entry.upstream.hash,
          entry.local?.hash,
          entry.local?.base,
          entry.removal ? undefined : entry.candidate?.hash,
          entry.deployed?.hash,
          entry.observed,
        ].filter((v): v is string => !!v))
          getObject(ctx.home, digest);
        if (destinationHash(ctx, targetPath(ctx, entry.id)) !== expectedLive(entry))
          issues.push(`${entry.id}: live drift; capture or reconcile`);
      } catch (error) {
        let suggestion = "";
        try {
          if (entry.local?.archive) {
            const archive = readArchive(ctx.home, entry.local.archive);
            if (
              archive.kind === "local" &&
              archive.id === entry.id &&
              archive.revision === entry.local.commit
            )
              suggestion = "; valid archive available: run restore --dry-run";
          }
        } catch {
          /* No unsafe restore hint. */
        }
        issues.push(
          `${entry.id}: ${error instanceof Error ? error.message : "Invalid state"}${suggestion}`,
        );
      }
    }
    return {
      outcome: issues.length ? "ERROR" : "OK",
      issues,
      warnings,
      metadataInspector,
      backupScratch,
      scratchCapacity: scratchStatus.capacity,
      retainedDirectories,
      adapter: `${ctx.manifest.adapter}; filesystem preservation; catalog pickup unverified`,
      policy: ctx.manifest.policy,
      primary: ctx.manifest.primary,
      gardener: ctx.manifest.gardener,
    };
  }
  if (command === "probe")
    return probeSkills(sourceRoot(ctx, source(ctx, args[0] ?? "")), options.npx);
  if (command === "recover" && options.unlock) {
    const result = unlock(ctx, dryRun);
    if (dryRun)
      return {
        outcome: "DRY_RUN",
        ...result,
        pending: pending(ctx) !== null || libraryPending(ctx),
      };
  }
  if (dryRun) return mutate(ctx, command, args, options);
  // Restore collections left on mkdir by an older unsupported downgrade through
  // their existing kernel domain, retaining directory/legacy writer checks.
  const locking =
    command === "configure" &&
    options.lockBackend === "flock" &&
    ctx.manifest.runtimeVersion === 2 &&
    ctx.manifest.lockBackend !== "flock" &&
    (exists(
      join(
        ctx.runtime,
        ctx.manifest.runtimeVersion === 2
          ? "sync.lock"
          : (ctx.manifest.legacyLockName ?? "kernel.lock"),
      ),
    ) ||
      (ctx.manifest.legacyRuntime &&
        ctx.manifest.legacyRuntime !== ctx.runtime &&
        exists(join(ctx.manifest.legacyRuntime, ctx.manifest.legacyLockName ?? "kernel.lock"))))
      ? { ...ctx, manifest: { ...ctx.manifest, lockBackend: "flock" as const } }
      : ctx;
  return withLock(
    locking,
    () => {
      const current = load(home);
      return report(current, command, mutate(current, command, args, options));
    },
    command === "recover" || options.quietHost === true,
  );
}
function mutate(ctx: Context, command: string, args: string[], options: Options): unknown {
  const dryRun = options.dryRun ?? false;
  if (
    (pending(ctx) || libraryPending(ctx)) &&
    command !== "recover" &&
    !dryRun &&
    options.quietHost &&
    !scratchRepairPending(ctx.home)
  ) {
    const journal = pending(ctx);
    if (journal && journal.version !== 4) validateAutomaticReplacement(ctx, journal);
    const preview = libraryPending(ctx)
      ? recoverLibrary(ctx, true)
      : journal?.version === 4
        ? recoverRemoval(ctx, true)
        : recover(ctx, true);
    if ((preview as { drift?: boolean }).drift)
      fail("RECOVERY_REQUIRED", "Retained transaction bytes changed; inspect recover --dry-run");
    const recovered = libraryPending(ctx)
      ? recoverLibrary(ctx, false, false, undefined, true)
      : journal?.version === 4
        ? recoverRemoval(ctx, false)
        : recover(ctx, false);
    report(ctx, "recover", recovered);
    ctx.lock = load(ctx.home).lock;
  }
  if (
    (pending(ctx) || libraryPending(ctx) || scratchRepairPending(ctx.home)) &&
    command !== "recover"
  )
    fail("RECOVERY_REQUIRED", "Run recover before further writes");
  if (command === "recover" && options.scratch) return recoverScratch(ctx, dryRun, options.expect);
  if (scratchRepairPending(ctx.home))
    fail("RECOVERY_REQUIRED", "Run recover --scratch --dry-run to inspect pending journal repair");
  if (command === "backup") {
    if (dryRun)
      return {
        outcome: "WOULD_BACKUP",
        directory: directoryTree(ctx.home, ctx.manifest.destination),
      };
    const point = createLibrarySnapshot(ctx, options.reason ?? "explicit whole-directory backup");
    return { outcome: "BACKED_UP", snapshot: point.id, hash: point.hash };
  }
  if (command === "revert")
    return revertLibrary(
      ctx,
      required(options.snapshot, "snapshot"),
      options.expect,
      dryRun,
      options.quietHost,
    );
  if (command === "configure") return configure(ctx, options);
  if (command === "migrate-storage") return migrateStorage(ctx, dryRun);
  if (command === "compact") return compact(ctx, options);
  if (command === "archive") return archiveAccepted(ctx, dryRun);
  if (command === "restore") return restoreMaterializations(ctx, dryRun);
  if (command === "add") {
    const query = qualifiedRepository(args[0] ?? fail("USAGE", "add requires a Git source"));
    const repo = repository(query.repository);
    const id = options.source ? checkedId(options.source, "Source ID") : sourceId(repo);
    const names = [...(query.skill ? [query.skill] : []), ...(options.skills ?? [])];
    if (options.all) names.push("*");
    if (options.id && (!names.length || names.includes("*") || names.length !== 1))
      fail("USAGE", "--id requires exactly one named skill");
    const existing = ctx.lock.sources.find((s) => s.id === id);
    if (
      existing &&
      (!sameRepository(existing.repository, repo) || (options.ref && existing.ref !== options.ref))
    )
      fail(
        "EXISTS",
        "Source ID belongs to a different repository/ref; use --source to disambiguate",
      );
    if (existing && !names.length) fail("EXISTS", "Source ID already exists");
    const ref = options.ref ?? existing?.ref ?? "HEAD";
    return scratch(ctx, (root) => {
      if (existing) sourceRoot(ctx, existing);
      const acquired = acquire(root, id, existing?.repository ?? repo, ref);
      const acquiredRoot = join(root, "repos", id);
      const fullDepth = options.fullDepth ?? existing?.fullDepth ?? false;
      const inventory = discover(acquiredRoot, fullDepth);
      const chosen = chooseSkills(inventory, names, repo);
      const selected = chosen.map((skill) => ({
        skill,
        id: options.id ? checkedId(options.id) : skillId(skill.name),
      }));
      if (new Set(selected.map((s) => s.id)).size !== selected.length)
        fail(
          "AMBIGUOUS",
          "Selected skills derive the same destination ID; select exact paths with distinct IDs",
        );
      for (const item of selected) {
        const entry = ctx.lock.entries.find(
          (e) => e.id === item.id || (e.source === id && e.path === item.skill.path),
        );
        if (
          entry &&
          (entry.id !== item.id ||
            entry.source !== id ||
            entry.path !== item.skill.path ||
            entry.name !== item.skill.name)
        )
          fail(
            "COLLISION",
            "Selected destination ID is already owned; use --id for an exact single selection",
          );
        if (!entry && destinationHash(ctx, targetPath(ctx, item.id)) !== null)
          fail("COLLISION", "Destination already exists and is not owned");
      }
      checkpointScratch(root);
      if (existing) sourceRoot(ctx, existing);
      const accepted = dryRun
        ? { ...acquired, fullDepth }
        : existing?.revision === acquired.revision
          ? { ...existing, fullDepth }
          : publishSource(ctx.home, {
              source: { ...acquired, fullDepth },
              root: acquiredRoot,
            });
      if (!dryRun) {
        if (existing) ctx.lock.sources = ctx.lock.sources.map((s) => (s.id === id ? accepted : s));
        else ctx.lock.sources.push(accepted);
        save(ctx);
      }
      if (!chosen.length) return { outcome: dryRun ? "WOULD_ADD" : "ADDED", source: accepted };
      // Preview selection against the isolated clone without publishing state.
      if (dryRun) {
        const entries = selected.map(({ skill, id: skillDestination }) => {
          const entry = ctx.lock.entries.find((e) => e.id === skillDestination);
          return entry
            ? stage(ctx, entry, accepted, acquiredRoot, true, root, inventory)
            : {
                id: skillDestination,
                source: id,
                path: skill.path,
                name: skill.name,
                outcome: "HELD",
                candidate: { hash: skill.hash, revision: acquired.revision },
                reasons: ["Exact candidate approval required"],
              };
        });
        return { outcome: "WOULD_SELECT", source: accepted, entries, holds: inventory.holds };
      }
      for (const { skill, id: skillDestination } of selected) {
        const existingEntry = ctx.lock.entries.find(
          (e) => e.source === id && e.path === skill.path,
        );
        if (existingEntry) {
          const staged = stage(ctx, existingEntry, accepted, acquiredRoot, false, root, inventory);
          ctx.lock.entries = ctx.lock.entries.map((e) => (e.id === existingEntry.id ? staged : e));
          save(ctx);
        } else
          mutate(ctx, "select", [id], {
            path: skill.path,
            id: skillDestination,
            ...(options.profile ? { profile: options.profile } : {}),
            fullDepth,
          });
      }
      const entries = selected.map(({ id }) => selection(ctx, id));
      const applied: unknown[] = [];
      let failed = entries.some(
        (e) => !e.candidate || e.outcome === "DRIFT" || e.outcome === "CONFLICT",
      );
      if ((options.yes || options.install) && options.reason?.trim())
        for (const entry of entries) {
          if (entry.removal || !entry.candidate) {
            failed = true;
            continue;
          }
          try {
            applied.push(
              mutate(ctx, "apply", [entry.id], {
                hash: entry.candidate.hash,
                reason: options.reason,
              }),
            );
          } catch (error) {
            failed = true;
            applied.push({
              id: entry.id,
              outcome: "ERROR",
              code: error instanceof SkilltreeError ? error.code : "ERROR",
            });
          }
        }
      return {
        outcome: failed ? "PARTIAL" : applied.length ? "UPDATED" : "HELD",
        source: accepted,
        entries: entries.map((e) => selection(ctx, e.id)),
        holds: inventory.holds,
        applied,
        events: eventsFor({ source: id, entries, holds: inventory.holds }),
      };
    });
  }
  if (command === "select") {
    const s = source(ctx, args[0] ?? "");
    const path = skillPath.parse(required(options.path, "path"));
    const id = slug.parse(required(options.id, "id"));
    if (ctx.lock.entries.some((e) => e.id === id || (e.source === s.id && e.path === path)))
      fail("EXISTS", "Selection or destination ID already owned");
    const root = sourceRoot(ctx, s);
    const inventory = discover(root, options.fullDepth ?? s.fullDepth);
    const hold = selectedHold(inventory, path);
    if (hold)
      throw new SkilltreeError(
        hold.code,
        `Source ${s.id}: ${hold.path}: ${hold.message}`,
        eventsFor({ source: s.id, holds: [hold] }),
      );
    const item = inventory.skills.find((e) => e.path === path);
    if (!item) fail("NOT_FOUND", "Exact skill path not in inventory");
    if (destinationHash(ctx, targetPath(ctx, id)) !== null)
      fail("COLLISION", "Destination already exists and is not owned");
    const tree = readTree(join(root, path), path === ".");
    const digest = treeHash(tree);
    const entry: Entry = {
      id,
      source: s.id,
      path,
      name: item.name,
      profiles: options.profile ? [slug.parse(options.profile)] : [],
      upstream: { hash: digest, revision: s.revision },
      local: null,
      candidate: { hash: digest, revision: s.revision },
      approval: null,
      deployed: null,
      observed: null,
      deployedBase: null,
      outcome: "HELD",
      reasons: [
        "Explicit installation or exact candidate approval required",
        ...triage(null, tree),
      ],
    };
    if (options.install) {
      entry.approval = {
        hash: digest,
        reason: required(options.reason, "reason"),
        kind: "user-install",
        at: new Date().toISOString(),
      };
      entry.outcome = "STAGED";
    }
    if (!dryRun) {
      putObject(ctx.home, tree);
      ctx.lock.entries.push(entry);
      save(ctx);
    }
    if (options.install)
      return dryRun ? { outcome: "WOULD_INSTALL", entry } : applyEntry(ctx, entry, digest, false);
    return { outcome: dryRun ? "WOULD_SELECT" : "SELECTED", entry, events: eventsFor({ entry }) };
  }
  if (command === "sync" || command === "plan") {
    const wanted = args.length ? selectedIds(ctx.lock.entries, ctx.lock.sources, args) : null;
    return scratch(ctx, (scratchRoot) => {
      const results: {
        id: string;
        outcome: "STAGED" | "PARTIAL" | "ERROR";
        holds?: Hold[];
        code?: string;
        message?: string;
      }[] = [];
      const successful = new Map<
        string,
        { source: Source; root: string; entries: Entry[]; discovery: Discovery }
      >();
      for (const s of ctx.lock.sources) {
        if (wanted && !ctx.lock.entries.some((e) => e.source === s.id && wanted.has(e.id)))
          continue;
        try {
          sourceRoot(ctx, s);
          const home = join(scratchRoot, s.id);
          fs.mkdirSync(home, { recursive: true });
          const item = acquire(home, s.id, s.repository, s.ref);
          const root = join(home, "repos", s.id);
          checkpointScratch(scratchRoot);
          const discovery = discover(root, s.fullDepth);
          const entries = ctx.lock.entries
            .filter((e) => e.source === s.id && (!wanted || wanted.has(e.id)))
            .map((e) => stage(ctx, e, item, root, true, scratchRoot, discovery));
          sourceRoot(ctx, s);
          checkpointScratch(scratchRoot);
          successful.set(s.id, {
            source: { ...item, ...(s.fullDepth ? { fullDepth: true } : {}) },
            root,
            entries,
            discovery,
          });
          results.push({
            id: s.id,
            outcome: entries.some((entry) => !entry.candidate) ? "PARTIAL" : "STAGED",
            holds: discovery.holds,
          });
        } catch (error) {
          const code = error instanceof SkilltreeError ? error.code : sourceFailure(error);
          results.push({
            id: s.id,
            outcome: "ERROR",
            code,
            message: `Source ${s.id} held; accepted state retained`,
          });
          // Keep single-source error compatibility, with an explicit source identity.
          if (ctx.lock.sources.length === 1)
            fail(
              code,
              `Source ${s.id}: ${error instanceof SkilltreeError ? error.message : "acquisition failed; accepted state retained"}`,
            );
        }
      }
      const previous = ctx.lock.sources;
      const sources = previous.map((s) => {
        const item = successful.get(s.id);
        if (!item || dryRun) return s;
        try {
          sourceRoot(ctx, s);
          item.discovery = discover(item.root, s.fullDepth);
          item.entries = ctx.lock.entries
            .filter((e) => e.source === s.id && (!wanted || wanted.has(e.id)))
            .map((e) => stage(ctx, e, item.source, item.root, false, scratchRoot, item.discovery));
          const result = results.find((r) => r.id === s.id)!;
          result.holds = item.discovery.holds;
          result.outcome = item.entries.some((entry) => !entry.candidate) ? "PARTIAL" : "STAGED";
          return s.checkout && s.revision === item.source.revision
            ? s
            : publishSource(ctx.home, item);
        } catch (error) {
          successful.delete(s.id);
          const result = results.find((r) => r.id === s.id)!;
          result.outcome = "ERROR";
          result.code = error instanceof SkilltreeError ? error.code : sourceFailure(error);
          result.message = `Source ${s.id} held; accepted state retained`;
          if (previous.length === 1) fail(result.code, result.message);
          return s;
        }
      });
      if (!dryRun)
        for (let i = 0; i < previous.length; i++) {
          const old = previous[i]!;
          if (!successful.has(old.id)) continue;
          try {
            sourceRoot(ctx, old);
          } catch (error) {
            successful.delete(old.id);
            sources[i] = old;
            const result = results.find((r) => r.id === old.id)!;
            result.outcome = "ERROR";
            result.code = error instanceof SkilltreeError ? error.code : sourceFailure(error);
            result.message = `Source ${old.id} changed before publication; accepted state retained`;
            if (previous.length === 1) fail(result.code, result.message);
          }
        }
      const entries = ctx.lock.entries.map(
        (entry) => successful.get(entry.source)?.entries.find((e) => e.id === entry.id) ?? entry,
      );
      if (!dryRun && successful.size) {
        ctx.lock.sources = sources;
        ctx.lock.entries = entries;
        save(ctx);
        // Accepted snapshots live in archives; only exact generated worktree files
        // are retired after the single atomic lock publication. Unknown work stays.
        for (const old of previous)
          if (sources.find((s) => s.id === old.id)?.checkout !== old.checkout && old.archive)
            retireSource(ctx.home, old);
      }
      let failed = results.some((r) => r.outcome !== "STAGED");
      const applied: unknown[] = [];
      if (
        command === "plan" &&
        !dryRun &&
        (options.yes || options.install) &&
        options.reason?.trim()
      )
        for (const entry of entries.filter((e) => !wanted || wanted.has(e.id))) {
          if (!successful.has(entry.source) || !entry.candidate || entry.removal) continue;
          try {
            applied.push(
              mutate(ctx, "apply", [entry.id], {
                hash: entry.candidate.hash,
                reason: options.reason,
              }),
            );
          } catch (error) {
            failed = true;
            applied.push({
              id: entry.id,
              outcome: "ERROR",
              code: error instanceof SkilltreeError ? error.code : "ERROR",
            });
          }
        }
      return {
        outcome: failed
          ? successful.size
            ? "PARTIAL"
            : "ERROR"
          : dryRun
            ? "DRY_RUN"
            : applied.length
              ? "UPDATED"
              : "STAGED",
        dryRun,
        sources: results,
        entries: command === "plan" && applied.length ? ctx.lock.entries : entries,
        ...(command === "plan" ? { applied } : {}),
        events: eventsFor({ sources: results, entries }),
      };
    });
  }
  if (command === "remove") {
    let ids = options.skills ?? [];
    let sourceName = options.source;
    if (sourceName && args.length) fail("USAGE", "Use --source without positional names");
    if (args.length && ids.length) fail("USAGE", "Do not combine positional names and --skill");
    if (args.length) {
      for (const name of args)
        if (
          ctx.lock.sources.some((s) => s.id === name) &&
          ctx.lock.entries.some((e) => e.id === name || e.name === name)
        )
          fail("AMBIGUOUS", "Name matches a source and a skill; use --source or --skill");
      if (args.length === 1 && ctx.lock.sources.some((s) => s.id === args[0])) {
        if (ctx.lock.entries.some((e) => e.id === args[0] || e.name === args[0]))
          fail("AMBIGUOUS", "Name matches a source and a skill; use --source or --skill");
        sourceName = args[0];
      } else ids = [...selectedIds(ctx.lock.entries, ctx.lock.sources, args)];
    } else if (ids.length && !ids.includes("*"))
      ids = [...selectedIds(ctx.lock.entries, ctx.lock.sources, ids)];
    if (ids.includes("*")) {
      if (ids.length !== 1) fail("USAGE", "Do not combine '*' with named removal selections");
      options = { ...options, all: true };
      ids = [];
    }
    const result = stageRemovals(ctx, ids, {
      source: sourceName,
      force: options.force,
      all: options.all,
      dryRun,
    });
    if (!dryRun && (options.yes || options.install) && options.reason?.trim()) {
      const entries = (result as { entries?: Entry[] }).entries ?? [];
      const applied: unknown[] = [];
      let failed = false;
      for (const entry of entries)
        try {
          applied.push(
            mutate(ctx, "apply", [entry.id], {
              hash: entry.candidate!.hash,
              reason: options.reason,
            }),
          );
        } catch (error) {
          failed = true;
          applied.push({
            id: entry.id,
            outcome: "ERROR",
            code: error instanceof SkilltreeError ? error.code : "ERROR",
          });
        }
      return { outcome: failed ? "PARTIAL" : "REMOVED", staged: result, applied };
    }
    return result;
  }
  if (command === "recover")
    return libraryPending(ctx)
      ? recoverLibrary(ctx, dryRun, options.keepCurrent, options.expect, options.quietHost)
      : pending(ctx)?.version === 4
        ? recoverRemoval(ctx, dryRun)
        : recover(ctx, dryRun);
  const entry = selection(ctx, args[0] ?? fail("USAGE", `${command} requires a selection ID`));
  if (command === "assign") {
    const profile = slug.parse(required(options.profile, "profile"));
    if (!entry.profiles.includes(profile)) entry.profiles.push(profile);
    if (!dryRun) save(ctx);
    return {
      outcome: dryRun ? "WOULD_ASSIGN" : "ASSIGNED",
      id: entry.id,
      profiles: entry.profiles,
    };
  }
  if (command === "capture") {
    if (!entry.deployed) fail("UNOWNED", "Only previously deployed skills can be captured");
    const target = targetPath(ctx, entry.id);
    const tree = readTree(target, false, ctx.manifest.hostMetadata ?? []);
    const meta = metadataTree(tree);
    if (meta.name !== entry.name)
      fail("IDENTITY_CHANGED", "Live skill identity changed; reconcile deliberately");
    const digest = treeHash(tree);
    preflightLocal(ctx.home, entry.id, entry.local);
    if (!dryRun) {
      putObject(ctx.home, tree);
      entry.local = {
        hash: digest,
        base: entry.deployedBase ?? entry.upstream.hash,
        commit: recordLocal(ctx.home, entry.id, tree, entry.local),
        ...(entry.local?.checkout ? { checkout: entry.local.checkout } : {}),
      };
      entry.local = {
        ...entry.local,
        archive: archiveRepository(
          ctx.home,
          localPath(ctx.home, entry.id, entry.local),
          "local",
          entry.id,
          entry.local.commit,
          null,
        ),
      };
      entry.observed = digest;
      entry.candidate = null;
      delete entry.removal;
      entry.outcome = "HELD";
      entry.reasons = ["Captured local edits; run sync to reconcile and stage before approval"];
      save(ctx);
    }
    return { outcome: dryRun ? "WOULD_CAPTURE" : "CAPTURED", id: entry.id, hash: digest };
  }
  if (
    (command === "approve" || command === "apply") &&
    ["CONFLICT", "DRIFT"].includes(entry.outcome)
  )
    fail(entry.outcome, "Reconcile the held selection before approval or apply");
  if (command === "approve" || (command === "apply" && options.reason !== undefined)) {
    const digest = hash.parse(required(options.hash, "hash"));
    const reason = required(options.reason, "reason");
    if (!entry.candidate || entry.candidate.hash !== digest)
      fail("STALE_CANDIDATE", "Approval must name the current complete candidate hash");
    if (!entry.removal) getObject(ctx.home, digest);
    if (destinationHash(ctx, targetPath(ctx, entry.id)) !== expectedLive(entry))
      fail("DRIFT", "Capture or reconcile live drift before approving");
    if (!dryRun || command === "apply") {
      entry.approval = {
        hash: digest,
        reason,
        kind: "explicit-review",
        at: new Date().toISOString(),
      };
      entry.outcome = "STAGED";
      if (!dryRun) save(ctx);
    }
    if (command === "approve")
      return { outcome: dryRun ? "WOULD_APPROVE" : "APPROVED", id: entry.id, hash: digest };
  }
  if (command === "apply")
    return entry.removal
      ? applyRemoval(ctx, entry, hash.parse(required(options.hash, "hash")), dryRun)
      : applyEntry(ctx, entry, hash.parse(required(options.hash, "hash")), dryRun);
  return fail("USAGE", `Unknown command ${command}`);
}
