import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateAutomaticReplacement } from "../src/automatic-recovery";
import { applyEntry, expectedLive, paths } from "../src/deployment";
import { execute } from "../src/service";
import { load, pending, withLock } from "../src/state";
import { atomicJson, treeHash, readTree } from "../src/files";
import { archiveRepository } from "../src/archives";
import { git, localPath } from "../src/git";
import { type Journal } from "../src/model";
import { authoritative, body, candidate, commit, editBody, fixture, install } from "./helpers";

type ReplacementJournal = Exclude<Journal, { version: 4 }>;
type Phase = "before-move" | "after-move" | "after-placement" | "after-lock";
function interrupted(phase: Phase, local = false) {
  const f = fixture();
  try {
    install(f.home);
    if (local) {
      editBody(join(f.dest, "helper"), "First line", "Captured local line");
      execute(f.home, "capture", ["helper"]);
    }
    editBody(f.skill, "Last line", "Upstream update");
    commit(f.repo, "update fixture");
    execute(f.home, "plan", []);
    execute(f.home, "approve", ["helper"], {
      hash: candidate(f.home),
      reason: "Reviewed exact fixture update",
    });
    const ctx = load(f.home),
      before = structuredClone(ctx.lock),
      hash = candidate(f.home);
    expect(() =>
      withLock(ctx, () =>
        applyEntry(ctx, ctx.lock.entries[0]!, hash, false, () => {
          throw new Error("fixture interruption");
        }),
      ),
    ).toThrow("fixture interruption");
    const journal = pending(load(f.home))!;
    if (journal.version === 4) throw new Error("unexpected removal journal");
    const transaction = paths(ctx, journal.transaction);
    if (phase === "before-move") fs.renameSync(transaction.backup, join(f.dest, "helper"));
    if (phase === "after-placement" || phase === "after-lock")
      fs.renameSync(transaction.stage, join(f.dest, "helper"));
    if (phase === "after-lock") {
      const after = structuredClone(before);
      after.entries[0] = journal.next;
      atomicJson(join(f.home, "skilltree.lock"), after);
    }
    return { ...f, journal, transaction, before, hash };
  } catch (error) {
    f.cleanup();
    throw error;
  }
}

for (const local of [false, true]) {
  for (const phase of ["before-move", "after-move", "after-placement", "after-lock"] as const) {
    test(`automatic replacement recovery retains exact intent ${phase}${local ? " with local history" : ""}`, () => {
      const f = interrupted(phase, local);
      try {
        const unchanged = authoritative(f.home);
        validateAutomaticReplacement(load(f.home), f.journal);
        expect(authoritative(f.home)).toBe(unchanged);
        expect(execute(f.home, "backup", [], { quietHost: true })).toMatchObject({
          result: { outcome: "BACKED_UP" },
        });
        expect(pending(load(f.home))).toBeNull();
        const entry = load(f.home).lock.entries[0]!,
          completed = phase === "after-placement" || phase === "after-lock";
        expect(entry).toEqual(completed ? f.journal.next : f.before.entries[0]!);
        expect(treeHash(readTree(join(f.dest, "helper")))).toBe(
          completed ? f.hash : expectedLive(f.before.entries[0]!)!,
        );
        if (local) expect(body(join(f.dest, "helper"))).toContain("Captured local line");
      } finally {
        f.cleanup();
      }
    });
  }
}

const changes: [string, (journal: ReplacementJournal) => void][] = [
  ["profiles", (journal) => journal.next.profiles.push("unknown-owner")],
  ["identity", (journal) => (journal.next.path = "skills/another")],
  ["upstream", (journal) => (journal.next.upstream.revision = "0".repeat(40))],
  ["candidate", (journal) => (journal.next.candidate!.hash = journal.oldHash!)],
  ["approval reason", (journal) => (journal.next.approval!.reason = "Unreviewed replacement")],
  ["approval hash", (journal) => (journal.next.approval!.hash = journal.oldHash!)],
  ["deployment", (journal) => (journal.next.deployed!.revision = "0".repeat(40))],
  ["old hash", (journal) => (journal.oldHash = journal.next.candidate!.hash)],
  ["configuration", (journal) => (journal.configuration = "0".repeat(64))],
  [
    "added local ownership",
    (journal) =>
      (journal.next.local = {
        hash: journal.next.candidate!.hash,
        base: journal.next.upstream.hash,
        commit: journal.next.upstream.revision,
      }),
  ],
];
for (const [name, change] of changes) {
  test(`automatic recovery holds altered journal ${name} after placement without writes`, () => {
    const f = interrupted("after-placement");
    try {
      change(f.journal);
      atomicJson(join(f.home, "transaction.json"), f.journal);
      const before = authoritative(f.home),
        library = authoritative(f.dest),
        retained = authoritative(f.transaction.root);
      expect(() => execute(f.home, "backup", [], { quietHost: true })).toThrow(
        expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
      );
      expect(authoritative(f.home)).toBe(before);
      expect(authoritative(f.dest)).toBe(library);
      expect(authoritative(f.transaction.root)).toBe(retained);
      expect(pending(load(f.home))).not.toBeNull();
    } finally {
      f.cleanup();
    }
  });
}

const localChanges: [string, (journal: ReplacementJournal) => void][] = [
  ["hash", (journal) => (journal.next.local!.hash = journal.oldHash!)],
  ["base", (journal) => (journal.next.local!.base = journal.oldHash!)],
  ["checkout", (journal) => (journal.next.local!.checkout = randomUUID())],
  ["commit", (journal) => (journal.next.local!.commit = "0".repeat(40))],
  ["archive", (journal) => (journal.next.local!.archive = "0".repeat(64))],
];
for (const [name, change] of localChanges) {
  test(`automatic recovery holds altered local ${name} evidence`, () => {
    const f = interrupted("after-placement", true);
    try {
      change(f.journal);
      atomicJson(join(f.home, "transaction.json"), f.journal);
      const before = authoritative(f.home),
        library = authoritative(f.dest);
      expect(() => execute(f.home, "backup", [], { quietHost: true })).toThrow();
      expect(authoritative(f.home)).toBe(before);
      expect(authoritative(f.dest)).toBe(library);
      expect(pending(load(f.home))).not.toBeNull();
    } finally {
      f.cleanup();
    }
  });
}

test("automatic recovery rejects foreign archive provenance and changed collection ownership", () => {
  const f = interrupted("after-placement", true);
  try {
    const local = f.journal.next.local!;
    local.archive = archiveRepository(
      f.home,
      localPath(f.home, "helper", local),
      "source",
      "helper",
      local.commit,
      null,
    );
    expect(() => validateAutomaticReplacement(load(f.home), f.journal)).toThrow(
      expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
    );
    const journal = pending(load(f.home))!;
    if (journal.version === 4) throw new Error("unexpected removal journal");
    const current = load(f.home);
    current.lock.entries[0]!.profiles.push("unknown-owner");
    atomicJson(join(f.home, "skilltree.lock"), current.lock);
    const before = authoritative(f.home);
    expect(() => execute(f.home, "backup", [], { quietHost: true })).toThrow(
      expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
    );
    expect(authoritative(f.home)).toBe(before);
  } finally {
    f.cleanup();
  }
});

test("automatic recovery rejects disconnected local history even with approved bytes and a valid archive", () => {
  const f = interrupted("after-placement", true);
  try {
    const local = f.journal.next.local!,
      root = localPath(f.home, "helper", local);
    git(root, ["checkout", "--orphan", "unrelated-fixture-history"]);
    git(root, ["commit", "--allow-empty", "-m", `Capture content ${f.hash}`]);
    local.commit = git(root, ["rev-parse", "HEAD"]);
    local.archive = archiveRepository(f.home, root, "local", "helper", local.commit, null);
    atomicJson(join(f.home, "transaction.json"), f.journal);
    const before = authoritative(f.home);
    expect(() => execute(f.home, "backup", [], { quietHost: true })).toThrow(
      "does not retain the accepted commit",
    );
    expect(authoritative(f.home)).toBe(before);
    expect(pending(load(f.home))).not.toBeNull();
  } finally {
    f.cleanup();
  }
});

test("automatic recovery holds legacy journals without snapshot evidence while explicit recovery works", () => {
  const f = interrupted("after-move");
  try {
    delete f.journal.recoveryPoint;
    delete f.journal.configuration;
    atomicJson(join(f.home, "transaction.json"), f.journal);
    const before = authoritative(f.home);
    expect(() => execute(f.home, "backup", [], { quietHost: true })).toThrow(
      expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
    );
    expect(authoritative(f.home)).toBe(before);
    expect(execute(f.home, "recover", [])).toMatchObject({ result: { outcome: "RECOVERED" } });
    expect(pending(load(f.home))).toBeNull();
  } finally {
    f.cleanup();
  }
});
