import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { load, pending, withLock } from "../src/state";
import { applyEntry, paths, recover, storageRoot } from "../src/deployment";
import { atomicJson, liveHash } from "../src/files";
import { execute } from "../src/service";
import {
  fixture,
  install,
  editBody,
  commit,
  candidate,
  approveApply,
  authoritative,
} from "./helpers";

function catalog(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((item) => {
    const path = join(root, item.name);
    return item.isDirectory() ? catalog(path) : item.name === "SKILL.md" ? [path] : [];
  });
}
test("recursive catalog sees only deployed skills through replacement, interruption and recovery", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(f.skill, "Last line", "Update");
    commit(f.repo, "update");
    execute(f.home, "sync", []);
    execute(f.home, "approve", ["helper"], { hash: candidate(f.home), reason: "review" });
    const ctx = load(f.home);
    expect(() =>
      withLock(ctx, () =>
        applyEntry(ctx, ctx.lock.entries[0]!, candidate(f.home), false, () => {
          expect(catalog(f.dest)).toHaveLength(0);
          expect(catalog(storageRoot(ctx))).toHaveLength(2);
          throw new Error("crash");
        }),
      ),
    ).toThrow("crash");
    expect(pending(ctx)?.version).toBe(2);
    recover(ctx, false);
    expect(catalog(f.dest)).toEqual([join(f.dest, "helper/SKILL.md")]);
    approveApply(f.home);
    expect(catalog(f.dest)).toEqual([join(f.dest, "helper/SKILL.md")]);
    expect(catalog(storageRoot(ctx)).length).toBeGreaterThan(0);
  } finally {
    f.cleanup();
  }
});
test("legacy journal restores its original destination-local backup", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home);
    const entry = ctx.lock.entries[0]!;
    const transaction = "4e800ae6-51ad-4bfe-8747-624e50289601";
    const p = paths(ctx, transaction, true);
    fs.mkdirSync(p.root);
    fs.cpSync(join(f.dest, "helper"), p.stage, { recursive: true });
    fs.writeFileSync(join(p.root, "notes.txt"), "unknown notes survive relocation");
    fs.renameSync(join(f.dest, "helper"), p.backup);
    atomicJson(join(f.home, "transaction.json"), {
      version: 1,
      transaction,
      id: "helper",
      oldHash: entry.deployed!.hash,
      next: entry,
    });
    expect(recover(load(f.home), false)).toMatchObject({ outcome: "RECOVERED" });
    expect(liveHash(join(f.dest, "helper"))).toBe(entry.deployed!.hash);
    expect(catalog(f.dest)).toEqual([join(f.dest, "helper/SKILL.md")]);
    expect(fs.existsSync(p.root)).toBe(false);
    const moved = paths(ctx, transaction);
    expect(fs.readFileSync(join(moved.root, "notes.txt"), "utf8")).toBe(
      "unknown notes survive relocation",
    );
    expect(fs.existsSync(join(moved.stage, "SKILL.md"))).toBe(true);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});
test("unknown transaction storage holds before local history or destination changes", () => {
  const f = fixture();
  try {
    const ctx = load(f.home);
    fs.mkdirSync(storageRoot(ctx));
    fs.writeFileSync(join(storageRoot(ctx), "notes"), "retain");
    const before = authoritative(f.home);
    expect(() => install(f.home)).toThrow(expect.objectContaining({ code: "STORAGE_UNOWNED" }));
    expect(liveHash(join(f.dest, "helper"))).toBeNull();
    // Selection approval was explicitly recorded; no deployment or local history was created.
    expect(load(f.home).lock.entries[0]!.deployed).toBeNull();
    expect(fs.existsSync(join(f.home, "edits"))).toBe(false);
    expect(fs.readFileSync(join(storageRoot(ctx), "notes"), "utf8")).toBe("retain");
    expect(before.length).toBeGreaterThan(0);
  } finally {
    f.cleanup();
  }
});
test("new journal refuses a forged storage path without moving retained bytes", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home);
    const entry = ctx.lock.entries[0]!;
    atomicJson(join(f.home, "transaction.json"), {
      version: 2,
      storage: f.root,
      transaction: "4e800ae6-51ad-4bfe-8747-624e50289601",
      id: "helper",
      oldHash: null,
      next: entry,
    });
    const before = authoritative(f.home);
    expect(() => recover(ctx, false)).toThrow("Unexpected transaction storage");
    expect(authoritative(f.home)).toBe(before);
    expect(liveHash(join(f.dest, "helper"))).toBe(entry.deployed!.hash);
  } finally {
    f.cleanup();
  }
});

test("restart resumes an interrupted legacy storage relocation", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home);
    const entry = ctx.lock.entries[0]!;
    const transaction = "4e800ae6-51ad-4bfe-8747-624e50289601";
    const old = paths(ctx, transaction, true),
      moved = paths(ctx, transaction);
    fs.mkdirSync(old.root);
    fs.renameSync(join(f.dest, "helper"), old.backup);
    atomicJson(join(f.home, "transaction.json"), {
      version: 3,
      storage: storageRoot(ctx),
      transaction,
      id: "helper",
      oldHash: entry.deployed!.hash,
      next: entry,
    });
    // Model a crash after rename and before the location journal update.
    fs.renameSync(old.root, moved.root);
    expect(recover(load(f.home), true)).toMatchObject({ outcome: "WOULD_RESTORE" });
    expect(pending(ctx)?.version).toBe(3);
    expect(recover(load(f.home), false)).toMatchObject({ outcome: "RECOVERED" });
    expect(catalog(f.dest)).toEqual([join(f.dest, "helper/SKILL.md")]);
    expect(liveHash(join(f.dest, "helper"))).toBe(entry.deployed!.hash);
  } finally {
    f.cleanup();
  }
});
