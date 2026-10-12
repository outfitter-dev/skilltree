import * as fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  fail,
  slug,
  relativePath,
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
import { discover, metadataTree } from "./discovery";
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

export interface Options {
  keepCurrent?: boolean;
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
  if (!value) fail("USAGE", `Missing --${name}`);
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
    sources?: { id: string; outcome: string; code?: string }[];
    entries?: Entry[];
    outcome?: string;
    id?: string;
  };
  const events: unknown[] = [];
  for (const source of Array.isArray(value.sources) ? value.sources : [])
    if (source.outcome === "ERROR")
      events.push({
        version: 1,
        type: "source.error",
        source: source.id,
        code: source.code,
        action: "reconcile source and retry",
      });
  for (const entry of Array.isArray(value.entries) ? value.entries : [])
    if (["HELD", "CONFLICT", "DRIFT"].includes(entry.outcome))
      events.push({
        version: 1,
        type: `skill.${entry.outcome.toLowerCase()}`,
        id: entry.id,
        source: entry.source,
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
  const skill = discover(root).find((s) => s.path === entry.path);
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
  const upstreamTree = readTree(join(root, entry.path));
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
  metadataTree(candidateTree);
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
  if (!approved) reasons.unshift("Exact candidate approval required");
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
  if (command === "init") return initialize(home, options);
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
    return { source: s, skills: discover(sourceRoot(ctx, s)) };
  }
  if (command === "doctor") {
    const issues: string[] = [];
    const warnings: string[] = [];
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
    for (const name of fs.readdirSync(ctx.manifest.destination))
      if (name.startsWith(".skilltree-transaction-")) {
        const root = join(ctx.manifest.destination, name);
        if (exists(join(root, "backup/SKILL.md")) || exists(join(root, "stage/SKILL.md")))
          issues.push(
            "Legacy catalog-visible storage remains; run migrate-storage --dry-run and reconcile recognized ownership",
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
          entry.candidate?.hash,
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
  return withLock(
    ctx,
    () => {
      const current = load(home);
      return report(current, command, mutate(current, command, args, options));
    },
    command === "recover",
  );
}
function mutate(ctx: Context, command: string, args: string[], options: Options): unknown {
  const dryRun = options.dryRun ?? false;
  if ((pending(ctx) || libraryPending(ctx)) && command !== "recover")
    fail("RECOVERY_REQUIRED", "Run recover before further writes");
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
    return revertLibrary(ctx, required(options.snapshot, "snapshot"), options.expect, dryRun);
  if (command === "configure") return configure(ctx, options);
  if (command === "migrate-storage") return migrateStorage(ctx, dryRun);
  if (command === "compact") return compact(ctx, options);
  if (command === "archive") return archiveAccepted(ctx, dryRun);
  if (command === "restore") return restoreMaterializations(ctx, dryRun);
  if (command === "add") {
    const id = slug.parse(required(options.source, "source"));
    if (ctx.lock.sources.some((s) => s.id === id)) fail("EXISTS", "Source ID already exists");
    const repo = repository(args[0] ?? fail("USAGE", "add requires a Git source"));
    const ref = options.ref ?? "HEAD";
    return scratch(ctx, (root) => {
      const acquired = acquire(root, id, repo, ref);
      checkpointScratch(root);
      const accepted = dryRun
        ? acquired
        : publishSource(ctx.home, {
            source: acquired,
            root: join(root, "repos", id),
          });
      if (!dryRun) {
        ctx.lock.sources.push(accepted);
        save(ctx);
      }
      return { outcome: dryRun ? "WOULD_ADD" : "ADDED", source: accepted };
    });
  }
  if (command === "select") {
    const s = source(ctx, args[0] ?? "");
    const path = relativePath.parse(required(options.path, "path"));
    const id = slug.parse(required(options.id, "id"));
    if (ctx.lock.entries.some((e) => e.id === id || (e.source === s.id && e.path === path)))
      fail("EXISTS", "Selection or destination ID already owned");
    const root = sourceRoot(ctx, s);
    const item = discover(root).find((e) => e.path === path);
    if (!item) fail("NOT_FOUND", "Exact skill path not in inventory");
    if (destinationHash(ctx, targetPath(ctx, id)) !== null)
      fail("COLLISION", "Destination already exists and is not owned");
    const tree = readTree(join(root, path));
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
    return { outcome: dryRun ? "WOULD_SELECT" : "SELECTED", entry };
  }
  if (command === "sync")
    return scratch(ctx, (scratchRoot) => {
      const results: {
        id: string;
        outcome: "STAGED" | "ERROR";
        code?: string;
        message?: string;
      }[] = [];
      const successful = new Map<string, { source: Source; root: string; entries: Entry[] }>();
      for (const s of ctx.lock.sources) {
        try {
          sourceRoot(ctx, s);
          const home = join(scratchRoot, s.id);
          fs.mkdirSync(home, { recursive: true });
          const item = acquire(home, s.id, s.repository, s.ref);
          const root = join(home, "repos", s.id);
          checkpointScratch(scratchRoot);
          const entries = ctx.lock.entries
            .filter((e) => e.source === s.id)
            .map((e) => stage(ctx, e, item, root, true, scratchRoot));
          sourceRoot(ctx, s);
          checkpointScratch(scratchRoot);
          successful.set(s.id, { source: item, root, entries });
          results.push({ id: s.id, outcome: "STAGED" });
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
          item.entries = ctx.lock.entries
            .filter((e) => e.source === s.id)
            .map((e) => stage(ctx, e, item.source, item.root, false, scratchRoot));
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
      const failed = results.some((r) => r.outcome === "ERROR");
      return {
        outcome: dryRun ? "DRY_RUN" : failed ? (successful.size ? "PARTIAL" : "ERROR") : "STAGED",
        sources: results,
        entries,
        events: eventsFor({ sources: results, entries }),
      };
    });
  if (command === "recover")
    return libraryPending(ctx)
      ? recoverLibrary(ctx, dryRun, options.keepCurrent, options.expect)
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
      entry.outcome = "HELD";
      entry.reasons = ["Captured local edits; run sync to reconcile and stage before approval"];
      save(ctx);
    }
    return { outcome: dryRun ? "WOULD_CAPTURE" : "CAPTURED", id: entry.id, hash: digest };
  }
  if (command === "approve") {
    const digest = hash.parse(required(options.hash, "hash"));
    const reason = required(options.reason, "reason");
    if (!entry.candidate || entry.candidate.hash !== digest)
      fail("STALE_CANDIDATE", "Approval must name the current complete candidate hash");
    getObject(ctx.home, digest);
    if (destinationHash(ctx, targetPath(ctx, entry.id)) !== expectedLive(entry))
      fail("DRIFT", "Capture or reconcile live drift before approving");
    if (!dryRun) {
      entry.approval = {
        hash: digest,
        reason,
        kind: "explicit-review",
        at: new Date().toISOString(),
      };
      entry.outcome = "STAGED";
      save(ctx);
    }
    return { outcome: dryRun ? "WOULD_APPROVE" : "APPROVED", id: entry.id, hash: digest };
  }
  if (command === "apply")
    return applyEntry(ctx, entry, hash.parse(required(options.hash, "hash")), dryRun);
  return fail("USAGE", `Unknown command ${command}`);
}
