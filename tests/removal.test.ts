import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { applyRemoval, recoverRemoval, stageRemovals } from "../src/removal";
import { execute } from "../src/service";
import { load, pending, save, withLock, type Context } from "../src/state";
import { atomicJson, exists, treeHash, readTree } from "../src/files";
import { paths } from "../src/deployment";
import { readLibrarySnapshot } from "../src/library-backup";
import { localPath } from "../src/git";
import { fixture, install, editBody, commit, authoritative } from "./helpers";

function stage(home: string, ids: string[], options: Parameters<typeof stageRemovals>[2] = {}) {
  const ctx = load(home);
  return withLock(ctx, () => stageRemovals(ctx, ids, options));
}
function approve(home: string, id = "helper"): string {
  const ctx = load(home);
  return withLock(ctx, () => {
    const entry = ctx.lock.entries.find((item) => item.id === id)!;
    const hash = entry.candidate!.hash;
    entry.approval = {
      hash,
      reason: "Reviewed exact fixture removal",
      kind: "explicit-review",
      at: new Date().toISOString(),
    };
    entry.outcome = "STAGED";
    save(ctx);
    return hash;
  });
}
function apply(home: string, hash: string, afterBackup?: (ctx: Context) => void, id = "helper") {
  const ctx = load(home);
  return withLock(ctx, () =>
    applyRemoval(ctx, ctx.lock.entries.find((entry) => entry.id === id)!, hash, false, () =>
      afterBackup?.(ctx),
    ),
  );
}
function recover(home: string) {
  const ctx = load(home);
  return withLock(ctx, () => recoverRemoval(ctx, false), true);
}
function interrupted(home: string, hash: string) {
  expect(() =>
    apply(home, hash, () => {
      throw new Error("fixture interruption");
    }),
  ).toThrow("fixture interruption");
  const ctx = load(home),
    journal = pending(ctx)!;
  expect(journal.version).toBe(4);
  if (journal.version !== 4) throw new Error("wrong journal");
  return { ctx, journal, transaction: paths(ctx, journal.transaction) };
}

test("source force stages dependent removals without deleting source or bypassing approval", () => {
  const f = fixture();
  try {
    install(f.home);
    const original = load(f.home).lock.entries[0]!;
    const before = authoritative(f.home);
    expect(() => stage(f.home, [], { source: "upstream" })).toThrow(
      expect.objectContaining({ code: "SOURCE_SELECTED" }),
    );
    expect(authoritative(f.home)).toBe(before);
    const dry = stageRemovals(load(f.home), [], { source: "upstream", force: true, dryRun: true });
    expect(dry).toMatchObject({
      outcome: "WOULD_STAGE_REMOVALS",
      entries: [{ removal: { retireSource: true }, approval: null }],
    });
    expect(authoritative(f.home)).toBe(before);
    stage(f.home, [], { source: "upstream", force: true });
    const current = load(f.home).lock;
    expect(current.sources).toHaveLength(1);
    expect(current.entries[0]!.deployed).toEqual(original.deployed);
    expect(current.entries[0]!.removal!.previous.approval).toEqual(original.approval);
    expect(current.entries[0]!.candidate!.hash).not.toBe(original.deployed!.hash);
    expect(() => apply(f.home, current.entries[0]!.candidate!.hash)).toThrow(
      expect.objectContaining({ code: "HELD" }),
    );
    const hash = approve(f.home);
    const result = apply(f.home, hash) as { recoveryPoint: string; retainedBackup: string };
    expect(load(f.home).lock).toMatchObject({ sources: [], entries: [] });
    expect(exists(join(f.dest, "helper"))).toBe(false);
    expect(treeHash(readTree(result.retainedBackup))).toBe(original.deployed!.hash);
    expect(readLibrarySnapshot(load(f.home), result.recoveryPoint).lock).toMatchObject({
      sources: [{ id: "upstream" }],
      entries: [{ id: "helper" }],
    });
  } finally {
    f.cleanup();
  }
});

test("exact approved removal preserves complete backup, captured history and all dry-run bytes", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(join(f.dest, "helper"), "First line", "Captured local line");
    execute(f.home, "capture", ["helper"]);
    const original = load(f.home).lock.entries[0]!;
    const history = localPath(f.home, original.id, original.local);
    const historyBefore = authoritative(history);
    stage(f.home, ["helper"]);
    const hash = approve(f.home),
      ctx = load(f.home);
    const before = authoritative(f.home),
      library = treeHash(readTree(join(f.dest, "helper")));
    expect(applyRemoval(ctx, ctx.lock.entries[0]!, hash, true)).toMatchObject({
      outcome: "WOULD_REMOVE",
      hash,
    });
    expect(authoritative(f.home)).toBe(before);
    expect(treeHash(readTree(join(f.dest, "helper")))).toBe(library);
    const result = apply(f.home, hash) as { recoveryPoint: string; retainedBackup: string };
    expect(treeHash(readTree(result.retainedBackup))).toBe(library);
    expect(authoritative(history)).toBe(historyBefore);
    expect(load(f.home).lock.entries).toEqual([]);
    expect(load(f.home).lock.sources).toHaveLength(1);
    expect(readLibrarySnapshot(load(f.home), result.recoveryPoint).lock.entries[0]!.local).toEqual(
      original.local,
    );
  } finally {
    f.cleanup();
  }
});

test("combined removal approval preview accepts only prospective approval without writes", () => {
  const f = fixture();
  try {
    install(f.home);
    stage(f.home, ["helper"]);
    const hash = load(f.home).lock.entries[0]!.candidate!.hash;
    const before = authoritative(f.home),
      library = treeHash(readTree(join(f.dest, "helper")));
    expect(
      execute(f.home, "apply", ["helper"], {
        hash,
        reason: "Reviewed exact fixture removal preview",
        dryRun: true,
      }),
    ).toMatchObject({ outcome: "WOULD_REMOVE", hash });
    expect(authoritative(f.home)).toBe(before);
    expect(treeHash(readTree(join(f.dest, "helper")))).toBe(library);
    const changed = load(f.home),
      entry = changed.lock.entries[0]!;
    entry.profiles.push("unknown-profile");
    entry.approval = {
      hash,
      reason: "Prospective approval cannot authorize changed ownership",
      kind: "explicit-review",
      at: new Date().toISOString(),
    };
    expect(() => applyRemoval(changed, entry, hash, true)).toThrow(
      expect.objectContaining({ code: "REMOVAL_STATE_CHANGED" }),
    );
    expect(authoritative(f.home)).toBe(before);
  } finally {
    f.cleanup();
  }
});

test("undeployed selection removal retains registration through guarded approval without a backup move", () => {
  const f = fixture();
  try {
    execute(f.home, "select", ["upstream"], { path: ".agents/skills/helper", id: "helper" });
    stage(f.home, ["helper"]);
    const hash = approve(f.home);
    expect(apply(f.home, hash)).toMatchObject({ outcome: "REMOVED", retainedBackup: null });
    expect(load(f.home).lock.entries).toHaveLength(0);
    expect(load(f.home).lock.sources).toHaveLength(1);
    expect(exists(join(f.dest, "helper"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("removal writes require the active writer before staging, applying and recovering", () => {
  const f = fixture();
  try {
    install(f.home);
    let before = authoritative(f.home);
    expect(() => stageRemovals(load(f.home), ["helper"])).toThrow(
      expect.objectContaining({ code: "LOCK_REQUIRED" }),
    );
    expect(authoritative(f.home)).toBe(before);
    stage(f.home, ["helper"]);
    const hash = approve(f.home),
      ctx = load(f.home);
    before = authoritative(f.home);
    expect(() => applyRemoval(ctx, ctx.lock.entries[0]!, hash, false)).toThrow(
      expect.objectContaining({ code: "LOCK_REQUIRED" }),
    );
    expect(authoritative(f.home)).toBe(before);
    expect(() =>
      apply(f.home, hash, (active) => {
        atomicJson(join(active.runtime, "lock/owner.json"), { pid: process.pid + 1 });
      }),
    ).toThrow(expect.objectContaining({ code: "LOCK_REQUIRED" }));
    expect(load(f.home).lock.entries).toHaveLength(1);
    expect(pending(load(f.home))?.version).toBe(4);
    before = authoritative(f.home);
    expect(() => recoverRemoval(load(f.home), false)).toThrow(
      expect.objectContaining({ code: "LOCK_REQUIRED" }),
    );
    expect(authoritative(f.home)).toBe(before);
    expect(recover(f.home)).toMatchObject({ outcome: "RECOVERED" });
  } finally {
    f.cleanup();
  }
});

test("force cannot stage conflicts, drift or unknown destination ownership", () => {
  const f = fixture();
  try {
    install(f.home);
    for (const outcome of ["CONFLICT", "DRIFT"] as const) {
      const ctx = load(f.home);
      ctx.lock.entries[0]!.outcome = outcome;
      save(ctx);
      const before = authoritative(f.home);
      expect(() => stage(f.home, [], { source: "upstream", force: true })).toThrow(
        expect.objectContaining({ code: outcome }),
      );
      expect(authoritative(f.home)).toBe(before);
    }
    const ctx = load(f.home);
    ctx.lock.entries[0]!.outcome = "CURRENT";
    save(ctx);
    editBody(join(f.dest, "helper"), "First line", "Uncaptured drift");
    expect(() => stage(f.home, [], { source: "upstream", force: true })).toThrow(
      expect.objectContaining({ code: "DRIFT" }),
    );
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    execute(g.home, "select", ["upstream"], { path: ".agents/skills/helper", id: "helper" });
    fs.cpSync(g.skill, join(g.dest, "helper"), { recursive: true });
    expect(() => stage(g.home, ["helper"])).toThrow(expect.objectContaining({ code: "COLLISION" }));
  } finally {
    g.cleanup();
  }
});

test("changed managed bytes and host metadata invalidate exact removal review", () => {
  const f = fixture();
  try {
    execute(f.home, "configure", [], { adapter: "grok" });
    install(f.home);
    const metadata = join(f.dest, "helper/runs.json");
    fs.writeFileSync(metadata, '{"run":1}');
    stage(f.home, ["helper"]);
    const hash = approve(f.home);
    fs.writeFileSync(metadata, '{"run":2}');
    const before = authoritative(f.home);
    expect(() => apply(f.home, hash)).toThrow(expect.objectContaining({ code: "STALE_REMOVAL" }));
    expect(authoritative(f.home)).toBe(before);
    stage(f.home, ["helper"]);
    const next = approve(f.home);
    expect(next).not.toBe(hash);
    expect(() => apply(f.home, hash)).toThrow(expect.objectContaining({ code: "STALE_CANDIDATE" }));
    editBody(join(f.dest, "helper"), "First line", "Unknown new bytes");
    expect(() => apply(f.home, next)).toThrow(expect.objectContaining({ code: "DRIFT" }));
  } finally {
    f.cleanup();
  }
});

test("interruption after rename preserves registration until verified restart completes", () => {
  const f = fixture();
  try {
    install(f.home);
    stage(f.home, [], { source: "upstream", force: true });
    const hash = approve(f.home);
    const { ctx, journal, transaction } = interrupted(f.home, hash);
    expect(exists(join(f.dest, "helper"))).toBe(false);
    expect(load(f.home).lock).toMatchObject({
      sources: [{ id: "upstream" }],
      entries: [{ id: "helper" }],
    });
    if (journal.oldHash === null) throw new Error("installed fixture has no live hash");
    expect(destinationBytes(transaction.backup)).toBe(journal.oldHash);
    const before = authoritative(f.home);
    expect(recoverRemoval(ctx, true)).toMatchObject({ outcome: "WOULD_COMPLETE" });
    expect(authoritative(f.home)).toBe(before);
    expect(recover(f.home)).toMatchObject({ outcome: "RECOVERED" });
    expect(load(f.home).lock).toMatchObject({ sources: [], entries: [] });
    expect(pending(load(f.home))).toBeNull();
    expect(readLibrarySnapshot(load(f.home), journal.recoveryPoint).lock.entries[0]!.id).toBe(
      "helper",
    );
  } finally {
    f.cleanup();
  }
});
function destinationBytes(path: string) {
  return treeHash(readTree(path));
}

test("restart aborts exact pre-move state and completes an already-published lock idempotently", () => {
  const f = fixture();
  try {
    install(f.home);
    stage(f.home, ["helper"]);
    const hash = approve(f.home);
    const first = interrupted(f.home, hash);
    fs.renameSync(first.transaction.backup, join(f.dest, "helper"));
    const before = authoritative(f.home);
    expect(recoverRemoval(load(f.home), true)).toMatchObject({ outcome: "WOULD_ABORT" });
    expect(authoritative(f.home)).toBe(before);
    expect(recover(f.home)).toMatchObject({
      outcome: "RECOVERED",
      action: "retain unchanged destination",
    });
    expect(load(f.home).lock.entries).toHaveLength(1);
    const second = interrupted(f.home, hash);
    atomicJson(join(f.home, "skilltree.lock"), second.journal.nextLock);
    expect(recover(f.home)).toMatchObject({ outcome: "RECOVERED" });
    expect(load(f.home).lock.entries).toHaveLength(0);
    expect(exists(second.transaction.backup)).toBe(true);
  } finally {
    f.cleanup();
  }
});

for (const mutation of ["backup", "target", "lock", "snapshot", "outside", "owner"] as const) {
  test(`unknown ${mutation} changes after intent hold without completing removal`, () => {
    const f = fixture();
    try {
      install(f.home);
      fs.writeFileSync(join(f.dest, "outside.txt"), "outside original");
      stage(f.home, ["helper"]);
      const hash = approve(f.home);
      expect(() =>
        apply(f.home, hash, (ctx) => {
          const journal = pending(ctx)!;
          if (journal.version !== 4) throw new Error("wrong journal");
          const transaction = paths(ctx, journal.transaction);
          if (mutation === "backup")
            fs.appendFileSync(join(transaction.backup, "SKILL.md"), "unknown backup bytes");
          if (mutation === "target") {
            fs.mkdirSync(join(f.dest, "helper"));
            fs.writeFileSync(join(f.dest, "helper/unknown.txt"), "unknown current bytes");
          }
          if (mutation === "lock") {
            const lock = load(f.home).lock;
            lock.entries[0]!.profiles.push("new-profile");
            atomicJson(join(f.home, "skilltree.lock"), lock);
          }
          if (mutation === "snapshot") {
            const point = join(f.home, "library-backups", journal.recoveryPoint + ".json");
            const value = JSON.parse(fs.readFileSync(point, "utf8"));
            value.reason = "changed";
            atomicJson(point, value);
          }
          if (mutation === "outside")
            fs.writeFileSync(join(f.dest, "outside.txt"), "outside changed");
          if (mutation === "owner") {
            const point = join(transaction.root, "owner.json");
            const value = JSON.parse(fs.readFileSync(point, "utf8"));
            value.collection = f.root;
            atomicJson(point, value);
          }
        }),
      ).toThrow();
      expect(pending(load(f.home))?.version).toBe(4);
      expect(load(f.home).lock.entries).toHaveLength(1);
      const before = authoritative(f.home);
      expect(() => recoverRemoval(load(f.home), true)).toThrow();
      expect(authoritative(f.home)).toBe(before);
    } finally {
      f.cleanup();
    }
  });
}

test("last dependent completion retires source and unused-source metadata removal retains a recovery point", () => {
  const f = fixture();
  try {
    fs.cpSync(f.skill, join(f.repo, "skills/other"), { recursive: true });
    commit(f.repo, "other skill");
    execute(f.home, "sync", []);
    install(f.home);
    execute(f.home, "select", ["upstream"], {
      path: "skills/other",
      id: "other",
      install: true,
      reason: "Explicit fixture request",
    });
    stage(f.home, [], { source: "upstream", force: true });
    apply(f.home, approve(f.home));
    expect(load(f.home).lock.sources).toHaveLength(1);
    apply(f.home, approve(f.home, "other"), undefined, "other");
    expect(load(f.home).lock.sources).toHaveLength(0);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    const before = authoritative(g.home);
    expect(stageRemovals(load(g.home), [], { source: "upstream", dryRun: true })).toMatchObject({
      outcome: "WOULD_REMOVE_SOURCE",
    });
    expect(authoritative(g.home)).toBe(before);
    const result = stage(g.home, [], { source: "upstream" }) as { recoveryPoint: string };
    expect(readLibrarySnapshot(load(g.home), result.recoveryPoint).lock.sources).toHaveLength(1);
    expect(load(g.home).lock.sources).toHaveLength(0);
    expect(fs.readdirSync(join(g.home, "repos")).length).toBeGreaterThan(0);
  } finally {
    g.cleanup();
  }
});
