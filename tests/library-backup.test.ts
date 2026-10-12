import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { execute } from "../src/service";
import { load, withLock } from "../src/state";
import {
  createLibrarySnapshot,
  libraryHash,
  readLibrarySnapshot,
  revertLibrary,
  libraryPending,
  recoverLibrary,
} from "../src/library-backup";
import {
  fixture,
  install,
  editBody,
  commit,
  candidate,
  approveApply,
  authoritative,
} from "./helpers";

test("every apply verifies the entire library including outside-lock skills and host metadata", () => {
  const f = fixture();
  try {
    const outside = join(f.dest, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "SKILL.md"), "Untracked skill\n");
    fs.writeFileSync(join(outside, "runs.json"), "host history\n");
    fs.writeFileSync(join(outside, "notes"), "untracked\n");
    fs.chmodSync(join(outside, "notes"), 0o640);
    fs.symlinkSync("notes", join(outside, "link"));
    const result = install(f.home) as { result: { recoveryPoint: string } };
    const ctx = load(f.home),
      point = readLibrarySnapshot(ctx, result.result.recoveryPoint);
    expect(point.tree.rows["outside/runs.json"]?.blob).toBeDefined();
    expect(point.tree.rows["outside/notes"]?.mode).toBe(0o640);
    expect(point.tree.rows["outside/link"]?.target).toBe("notes");
    expect(point.tree.rows["helper"]).toBeUndefined();
    fs.writeFileSync(join(outside, "notes"), "newer outside work\n");
    fs.writeFileSync(join(outside, "runs.json"), "newer host history\n");
    editBody(join(f.dest, "helper"), "First line", "Captured improvement");
    execute(f.home, "capture", ["helper"]);
    const local = load(f.home).lock.entries[0]!.local;
    const current = createLibrarySnapshot(load(f.home), "before fixture revert"),
      preview = execute(f.home, "revert", [], { snapshot: point.id, dryRun: true }) as {
        expected: string;
        diff: { removed: string[] };
      };
    expect(preview.diff.removed).toContain("helper/SKILL.md");
    execute(f.home, "revert", [], { snapshot: point.id, expect: preview.expected });
    expect(fs.readFileSync(join(outside, "notes"), "utf8")).toBe("untracked\n");
    expect(fs.readFileSync(join(outside, "runs.json"), "utf8")).toBe("host history\n");
    expect(fs.statSync(join(outside, "notes")).mode & 0o777).toBe(0o640);
    expect(fs.readlinkSync(join(outside, "link"))).toBe("notes");
    expect(load(f.home).lock.entries[0]!.local).toEqual(local);
    const back = execute(f.home, "revert", [], { snapshot: current.id, dryRun: true }) as {
      expected: string;
    };
    execute(f.home, "revert", [], { snapshot: current.id, expect: back.expected });
    expect(fs.readFileSync(join(outside, "notes"), "utf8")).toBe("newer outside work\n");
    expect(fs.readFileSync(join(f.dest, "helper/SKILL.md"), "utf8")).toContain(
      "Captured improvement",
    );
  } finally {
    f.cleanup();
  }
});
test("stale reviewed revert refuses newer edits without state or destination mutation", () => {
  const f = fixture();
  try {
    install(f.home);
    const point = createLibrarySnapshot(load(f.home), "point");
    const preview = execute(f.home, "revert", [], { snapshot: point.id, dryRun: true }) as {
      expected: string;
    };
    fs.writeFileSync(join(f.dest, "outside-note"), "newer");
    const before = authoritative(f.home),
      hash = libraryHash(load(f.home));
    expect(() =>
      execute(f.home, "revert", [], { snapshot: point.id, expect: preview.expected }),
    ).toThrow(expect.objectContaining({ code: "REVERT_STALE" }));
    expect(authoritative(f.home)).toBe(before);
    expect(libraryHash(load(f.home))).toBe(hash);
  } finally {
    f.cleanup();
  }
});
test("unsupported outside-lock entries fail closed before approved apply", () => {
  const f = fixture();
  try {
    install(f.home);
    const original = fs.readFileSync(join(f.dest, "helper/SKILL.md"));
    editBody(f.skill, "Last line", "update");
    commit(f.repo, "update");
    execute(f.home, "sync", []);
    execute(f.home, "approve", ["helper"], { hash: candidate(f.home), reason: "review" });
    const fifo = join(f.dest, "z-fifo");
    execFileSync("mkfifo", [fifo]);
    fs.writeFileSync(join(f.dest, "a-partial-file"), "read before failure");
    const count = fs.readdirSync(join(f.home, "library-backups")).length;
    expect(() => execute(f.home, "apply", ["helper"], { hash: candidate(f.home) })).toThrow(
      expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
    );
    expect(fs.readFileSync(join(f.dest, "helper/SKILL.md"))).toEqual(original);
    expect(fs.readdirSync(join(f.home, "library-backups"))).toHaveLength(count);
    fs.unlinkSync(fifo);
    fs.symlinkSync(f.repo, join(f.dest, "external-link"));
    expect(() => approveApply(f.home)).toThrow(
      expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
    );
    expect(fs.readFileSync(join(f.dest, "helper/SKILL.md"))).toEqual(original);
  } finally {
    f.cleanup();
  }
});
test("corrupt manifest or directory blob cannot be restored", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home),
      point = createLibrarySnapshot(ctx, "valid"),
      path = join(f.home, "library-backups", point.id + ".json");
    const json = fs.readFileSync(path, "utf8"),
      value = JSON.parse(json);
    value.reason = "tampered";
    fs.writeFileSync(path, JSON.stringify(value));
    const before = libraryHash(ctx);
    expect(() => execute(f.home, "revert", [], { snapshot: point.id, dryRun: true })).toThrow(
      expect.objectContaining({ code: "BACKUP_CORRUPT" }),
    );
    expect(libraryHash(ctx)).toBe(before);
    fs.writeFileSync(path, json);
    const blob = point.tree.rows["helper/SKILL.md"]!.blob!;
    fs.writeFileSync(join(f.home, "library-blobs", blob + ".bin"), "partial/corrupt payload");
    expect(() => readLibrarySnapshot(ctx, point.id)).toThrow(
      expect.objectContaining({ code: "BACKUP_CORRUPT" }),
    );
    expect(libraryHash(ctx)).toBe(before);
  } finally {
    f.cleanup();
  }
});
test("interrupted directory restoration rolls back safely and repeats recovery", () => {
  const f = fixture();
  try {
    install(f.home);
    const target = createLibrarySnapshot(load(f.home), "older");
    fs.writeFileSync(join(f.dest, "outside-note"), "current preserved");
    const ctx = load(f.home),
      before = libraryHash(ctx);
    expect(() =>
      withLock(ctx, () =>
        revertLibrary(ctx, target.id, before, false, () => {
          throw new Error("interruption");
        }),
      ),
    ).toThrow("interruption");
    expect(libraryPending(ctx)).toBe(true);
    expect(fs.existsSync(f.dest)).toBe(false);
    expect(() => execute(f.home, "sync", [])).toThrow(
      expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
    );
    expect(recoverLibrary(load(f.home), true)).toMatchObject({ outcome: "WOULD_ROLLBACK" });
    expect(recoverLibrary(load(f.home), false)).toMatchObject({ outcome: "RECOVERED" });
    expect(libraryHash(load(f.home))).toBe(before);
    expect(fs.readFileSync(join(f.dest, "outside-note"), "utf8")).toBe("current preserved");
    expect(execute(f.home, "recover", [])).toMatchObject({ result: { outcome: "CURRENT" } });
  } finally {
    f.cleanup();
  }
});
test("restart completes a placed restore but holds later unknown edits", () => {
  const f = fixture();
  try {
    install(f.home);
    const target = createLibrarySnapshot(load(f.home), "target");
    fs.writeFileSync(join(f.dest, "later"), "preserved");
    let ctx = load(f.home);
    expect(() =>
      withLock(ctx, () =>
        revertLibrary(ctx, target.id, libraryHash(ctx), false, undefined, () => {
          throw new Error("placed");
        }),
      ),
    ).toThrow("placed");
    expect(recoverLibrary(load(f.home), false)).toMatchObject({ outcome: "RECOVERED" });
    expect(libraryHash(load(f.home))).toBe(target.hash);
    expect(
      execute(f.home, "revert", [], { snapshot: target.id, expect: target.hash }),
    ).toMatchObject({ result: { outcome: "CURRENT" } });
    fs.writeFileSync(join(f.dest, "later"), "second current");
    ctx = load(f.home);
    expect(() =>
      withLock(ctx, () =>
        revertLibrary(ctx, target.id, libraryHash(ctx), false, undefined, () => {
          fs.writeFileSync(join(f.dest, "newer"), "do not clobber");
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "REVERT_STALE" }));
    expect(() => recoverLibrary(load(f.home), false)).toThrow(
      expect.objectContaining({ code: "DRIFT" }),
    );
    expect(fs.readFileSync(join(f.dest, "newer"), "utf8")).toBe("do not clobber");
    expect(libraryPending(ctx)).toBe(true);
    const keep = recoverLibrary(load(f.home), true, true) as { expected: string };
    expect(recoverLibrary(load(f.home), false, true, keep.expected)).toMatchObject({
      outcome: "RECOVERED",
    });
    expect(fs.readFileSync(join(f.dest, "newer"), "utf8")).toBe("do not clobber");
    expect(libraryPending(ctx)).toBe(false);
  } finally {
    f.cleanup();
  }
});
test("existing retention policies do not discard whole-directory recovery points", () => {
  const f = fixture();
  try {
    install(f.home);
    const point = createLibrarySnapshot(load(f.home), "promised");
    execute(f.home, "compact", [], { retainBackups: 0, caches: true });
    expect(readLibrarySnapshot(load(f.home), point.id).id).toBe(point.id);
    expect(execute(f.home, "backups", [])).toMatchObject({
      backups: expect.arrayContaining([expect.objectContaining({ id: point.id })]),
    });
  } finally {
    f.cleanup();
  }
});
