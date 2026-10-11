import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fail, slug, relativePath, hash, manifestSchema, type Entry, type Source } from "./model";
import {
  atomicJson,
  assertNoSymlinks,
  exists,
  getObject,
  inside,
  liveHash,
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
import { discover, metadata, metadataTree } from "./discovery";
import { load, pending, save, unlock, withLock, type Context } from "./state";
import { applyEntry, expectedLive, recover, targetPath } from "./deployment";
import { probeSkills } from "./skills-adapter";

export interface Options {
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
  fs.mkdirSync(root);
  for (const name of fs.readdirSync(item.root))
    fs.cpSync(join(item.root, name), join(root, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  preflightSource(root, source.repository, source.revision);
  return source;
}
function source(ctx: Context, id: string): Source {
  const item = ctx.lock.sources.find((s) => s.id === id);
  if (!item) fail("NOT_FOUND", `Unknown source ${id}`);
  return item;
}
function report(ctx: Context, command: string, result: unknown): unknown {
  const runId = randomUUID();
  atomicJson(join(ctx.home, "reports", `${runId}.json`), { runId, command, result });
  return { runId, result };
}
function scratch<T>(work: (root: string) => T): T {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skilltree-stage-")));
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
    adapter: "filesystem",
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
  if (liveHash(target) !== expectedLive(entry))
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
  if (command === "list" || command === "status" || command === "verify") {
    const rows = ctx.lock.entries
      .filter((e) => !options.profile || e.profiles.includes(options.profile))
      .map((entry) => {
        let actual: string | null;
        try {
          actual = liveHash(targetPath(ctx, entry.id));
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
      pending: pending(ctx) !== null,
      entries: rows,
    };
  }
  if (command === "inventory") {
    const s = source(ctx, args[0] ?? required(options.source, "source"));
    return { source: s, skills: discover(sourceRoot(ctx, s)) };
  }
  if (command === "doctor") {
    const issues: string[] = [];
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
    if (pending(ctx)) issues.push("Interrupted replacement; run recover");
    for (const item of ctx.lock.sources) {
      try {
        sourceRoot(ctx, item);
      } catch {
        issues.push(`${item.id}: acquired source missing, dirty, or at an unexpected revision`);
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
        if (liveHash(targetPath(ctx, entry.id)) !== expectedLive(entry))
          issues.push(`${entry.id}: live drift; capture or reconcile`);
      } catch (error) {
        issues.push(`${entry.id}: ${error instanceof Error ? error.message : "Invalid state"}`);
      }
    }
    return {
      outcome: issues.length ? "ERROR" : "OK",
      issues,
      adapter: "filesystem; catalog pickup unverified",
      policy: ctx.manifest.policy,
      primary: ctx.manifest.primary,
      gardener: ctx.manifest.gardener,
    };
  }
  if (command === "probe")
    return probeSkills(sourceRoot(ctx, source(ctx, args[0] ?? "")), options.npx);
  if (command === "recover" && options.unlock) {
    const result = unlock(ctx, dryRun);
    if (dryRun) return { outcome: "DRY_RUN", ...result, pending: pending(ctx) !== null };
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
  if (pending(ctx) && command !== "recover")
    fail("RECOVERY_REQUIRED", "Run recover before further writes");
  if (command === "add") {
    const id = slug.parse(required(options.source, "source"));
    if (ctx.lock.sources.some((s) => s.id === id)) fail("EXISTS", "Source ID already exists");
    const repo = repository(args[0] ?? fail("USAGE", "add requires a Git source"));
    const ref = options.ref ?? "HEAD";
    return scratch((root) => {
      const acquired = acquire(root, id, repo, ref);
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
    if (liveHash(targetPath(ctx, id)) !== null)
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
    return scratch((scratchRoot) => {
      for (const item of ctx.lock.sources) sourceRoot(ctx, item);
      const acquired = new Map<string, { source: Source; root: string }>();
      for (const s of ctx.lock.sources) {
        const home = join(scratchRoot, s.id);
        fs.mkdirSync(home, { recursive: true });
        const item = acquire(home, s.id, s.repository, s.ref);
        acquired.set(s.id, { source: item, root: join(home, "repos", s.id) });
      }
      let entries = ctx.lock.entries.map((entry) => {
        const item = acquired.get(entry.source)!;
        return stage(ctx, entry, item.source, item.root, true, scratchRoot);
      });
      if (!dryRun) {
        // Recheck accepted checkouts after slow fetch/validation. Never reset user work.
        for (const item of ctx.lock.sources) sourceRoot(ctx, item);
        entries = ctx.lock.entries.map((entry) => {
          const item = acquired.get(entry.source)!;
          return stage(ctx, entry, item.source, item.root, false, scratchRoot);
        });
        const sources = [...acquired.values()].map((item) => publishSource(ctx.home, item));
        for (const item of ctx.lock.sources) sourceRoot(ctx, item);
        ctx.lock.entries = entries;
        ctx.lock.sources = sources;
        save(ctx);
      }
      return { outcome: dryRun ? "DRY_RUN" : "STAGED", entries };
    });
  if (command === "recover") return recover(ctx, dryRun);
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
    const meta = metadata(target);
    if (meta.name !== entry.name)
      fail("IDENTITY_CHANGED", "Live skill identity changed; reconcile deliberately");
    const tree = readTree(target);
    const digest = treeHash(tree);
    preflightLocal(ctx.home, entry.id, entry.local);
    if (!dryRun) {
      putObject(ctx.home, tree);
      entry.local = {
        hash: digest,
        base: entry.deployedBase ?? entry.upstream.hash,
        commit: recordLocal(ctx.home, entry.id, tree, entry.local),
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
    if (liveHash(targetPath(ctx, entry.id)) !== expectedLive(entry))
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
