import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fixture, install, commit, authoritative } from "./helpers";
import { execute } from "../src/service";
import { load, withLock } from "../src/state";
import { atomicJson } from "../src/files";
import { sourcePath, localPath, MAX_GIT_OBJECT_BYTES } from "../src/git";
import { readArchive } from "../src/archives";
import { readLibrarySnapshot } from "../src/library-backup";
const linux = process.platform === "linux" ? test : test.skip;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function flock(home: string) {
  execute(home, "configure", [], { lockBackend: "flock" });
  return load(home);
}
function snapshot(home: string) {
  return (execute(home, "backup", []) as { result: { snapshot: string } }).result.snapshot;
}
function downgraded(home: string) {
  const ctx = flock(home);
  withLock(ctx, () =>
    atomicJson(join(home, "skilltree.json"), { ...ctx.manifest, lockBackend: "mkdir" }),
  );
  return ctx;
}
linux("configure refuses flock downgrade without changing data or the stable inode", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = flock(f.home),
      point = snapshot(f.home);
    const oldPoint = readLibrarySnapshot(load(f.home), point),
      path = join(ctx.runtime, "sync.lock"),
      inode = fs.statSync(path).ino,
      before = authoritative(f.home);
    for (const dryRun of [true, false])
      expect(() => execute(f.home, "configure", [], { lockBackend: "mkdir", dryRun })).toThrow(
        expect.objectContaining({ code: "LOCK_BACKEND_UNSUPPORTED" }),
      );
    expect(authoritative(f.home)).toBe(before);
    expect(load(f.home).manifest.lockBackend).toBe("flock");
    expect(fs.statSync(path).ino).toBe(inode);
    expect(execute(f.home, "backup", [])).toMatchObject({ result: { outcome: "BACKED_UP" } });
    expect(readLibrarySnapshot(load(f.home), point)).toEqual(oldPoint);
  } finally {
    f.cleanup();
  }
});
linux(
  "explicit flock configure restores an older broken downgrade without removing its inode",
  () => {
    const f = fixture();
    try {
      install(f.home);
      flock(f.home);
      const point = snapshot(f.home),
        oldPoint = readLibrarySnapshot(load(f.home), point),
        ctx = downgraded(f.home),
        inode = fs.statSync(join(ctx.runtime, "sync.lock")).ino,
        before = authoritative(f.home);
      expect(() => execute(f.home, "backup", [])).toThrow(
        expect.objectContaining({ code: "LOCKED" }),
      );
      expect(
        execute(f.home, "configure", [], { lockBackend: "flock", dryRun: true }),
      ).toMatchObject({ outcome: "WOULD_CONFIGURE" });
      expect(authoritative(f.home)).toBe(before);
      expect(execute(f.home, "configure", [], { lockBackend: "flock" })).toMatchObject({
        result: { outcome: "CONFIGURED" },
      });
      expect(load(f.home).manifest.lockBackend).toBe("flock");
      expect(fs.statSync(join(ctx.runtime, "sync.lock")).ino).toBe(inode);
      expect(execute(f.home, "backup", [])).toMatchObject({ result: { outcome: "BACKED_UP" } });
      expect(readLibrarySnapshot(load(f.home), point)).toEqual(oldPoint);
    } finally {
      f.cleanup();
    }
  },
);
linux(
  "backend restoration honors a held kernel lock and preserves unknown directory-lock bytes",
  () => {
    const f = fixture();
    try {
      const ctx = downgraded(f.home),
        before = authoritative(f.home);
      withLock(ctx, () => {
        const child = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            'import {execute} from "./src/service.ts";try{execute(process.argv[1],"configure",[],{lockBackend:"flock"});console.log("UNEXPECTED_SUCCESS")}catch(e){console.log(e.code)}',
            f.home,
          ],
          { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
        );
        expect(child.exitCode).toBe(0);
        expect(child.stdout.toString().trim()).toBe("LOCKED");
      });
      const dir = join(ctx.runtime, "lock");
      fs.mkdirSync(dir);
      fs.writeFileSync(join(dir, "unknown"), "preserve unknown lock bytes");
      expect(() => execute(f.home, "configure", [], { lockBackend: "flock" })).toThrow(
        expect.objectContaining({ code: "LOCKED" }),
      );
      expect(fs.readFileSync(join(dir, "unknown"), "utf8")).toBe("preserve unknown lock bytes");
      expect(authoritative(f.home)).toBe(before);
    } finally {
      f.cleanup();
    }
  },
);
linux("backend restoration also retains exclusion and the inode of a legacy kernel domain", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = flock(f.home),
      point = snapshot(f.home),
      original = readLibrarySnapshot(load(f.home), point),
      inode = fs.statSync(join(ctx.runtime, "sync.lock")).ino;
    withLock(ctx, () =>
      atomicJson(join(f.home, "skilltree.json"), {
        ...ctx.manifest,
        lockBackend: "mkdir",
        runtimeRoot: join(f.root, "moved-runtime"),
        legacyRuntime: ctx.runtime,
        legacyLockName: "sync.lock",
      }),
    );
    const before = authoritative(f.home);
    withLock(ctx, () => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'import {execute} from "./src/service.ts";try{execute(process.argv[1],"configure",[],{lockBackend:"flock"});console.log("UNEXPECTED_SUCCESS")}catch(e){console.log(e.code)}',
          f.home,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      expect(child.stdout.toString().trim()).toBe("LOCKED");
    });
    expect(authoritative(f.home)).toBe(before);
    execute(f.home, "configure", [], { lockBackend: "flock" });
    expect(execute(f.home, "backup", [])).toMatchObject({ result: { outcome: "BACKED_UP" } });
    expect(fs.statSync(join(ctx.runtime, "sync.lock")).ino).toBe(inode);
    expect(readLibrarySnapshot(load(f.home), point)).toEqual(original);
  } finally {
    f.cleanup();
  }
});
test("large unrelated Git object permits add, select, sync, archive and offline restore", () => {
  const f = fixture();
  try {
    const asset = randomBytes(12_000_000),
      digest = sha(asset);
    fs.writeFileSync(join(f.repo, "unrelated.bin"), asset);
    commit(f.repo, "large unrelated asset");
    const original = load(f.home).lock.sources[0]!;
    expect(execute(f.home, "add", [f.repo], { source: "large", ref: "main" })).toMatchObject({
      result: { outcome: "ADDED" },
    });
    expect(load(f.home).lock.sources[0]).toEqual(original);
    execute(f.home, "select", ["large"], {
      path: ".agents/skills/helper",
      id: "helper",
      install: true,
      reason: "Explicit regression fixture install",
    });
    const first = load(f.home).lock.sources.find((s) => s.id === "large")!;
    expect(readArchive(f.home, first.archive!)).toMatchObject({
      version: 2,
      revision: first.revision,
    });
    fs.appendFileSync(join(f.skill, "SKILL.md"), "Upstream update\n");
    commit(f.repo, "update small skill");
    const synced = execute(f.home, "sync", []) as { result: { sources: { outcome: string }[] } };
    expect(synced.result.sources.every((s) => s.outcome === "STAGED")).toBe(true);
    const accepted = load(f.home),
      large = accepted.lock.sources.find((s) => s.id === "large")!;
    expect(sha(fs.readFileSync(join(sourcePath(f.home, large), "unrelated.bin")))).toBe(digest);
    execute(f.home, "archive", []);
    const archived = load(f.home),
      entry = archived.lock.entries[0]!;
    fs.rmSync(sourcePath(f.home, archived.lock.sources.find((s) => s.id === "large")!), {
      recursive: true,
    });
    fs.renameSync(f.repo, f.repo + "-offline");
    execute(f.home, "restore", []);
    const restored = load(f.home),
      source = restored.lock.sources.find((s) => s.id === "large")!;
    expect(sha(fs.readFileSync(join(sourcePath(f.home, source), "unrelated.bin")))).toBe(digest);
    expect(restored.lock.entries[0]!.approval).toEqual(entry.approval);
    expect(restored.lock.entries[0]!.deployed).toEqual(entry.deployed);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});
test("local Git history above 10 MB captures, archives and restores its complete bytes", () => {
  const f = fixture();
  try {
    install(f.home);
    const a = Buffer.alloc(6_000_000, 65),
      b = Buffer.alloc(6_000_000, 66),
      live = join(f.dest, "helper");
    fs.writeFileSync(join(live, "a.bin"), a);
    fs.writeFileSync(join(live, "b.bin"), b);
    expect(execute(f.home, "capture", ["helper"])).toMatchObject({
      result: { outcome: "CAPTURED" },
    });
    execute(f.home, "archive", []);
    const entry = load(f.home).lock.entries[0]!;
    expect(readArchive(f.home, entry.local!.archive!)).toMatchObject({
      version: 2,
      revision: entry.local!.commit,
    });
    fs.rmSync(localPath(f.home, "helper", entry.local), { recursive: true });
    execute(f.home, "restore", []);
    const after = load(f.home).lock.entries[0]!,
      history = localPath(f.home, "helper", after.local);
    expect(after.local!.commit).toBe(entry.local!.commit);
    expect(after.approval).toEqual(entry.approval);
    expect(sha(fs.readFileSync(join(history, "a.bin")))).toBe(sha(a));
    expect(sha(fs.readFileSync(join(history, "b.bin")))).toBe(sha(b));
    expect(sha(fs.readFileSync(join(live, "a.bin")))).toBe(sha(a));
    expect(sha(fs.readFileSync(join(live, "b.bin")))).toBe(sha(b));
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});
test("an oversized Git object fails explicitly before publishing a source and preserves accepted data", () => {
  const f = fixture();
  try {
    install(f.home);
    const point = snapshot(f.home),
      oldPoint = readLibrarySnapshot(load(f.home), point),
      lock = fs.readFileSync(join(f.home, "skilltree.lock")),
      manifest = fs.readFileSync(join(f.home, "skilltree.json")),
      path = join(f.repo, "oversized.bin");
    fs.writeFileSync(path, "");
    fs.truncateSync(path, MAX_GIT_OBJECT_BYTES + 1);
    commit(f.repo, "oversized unrelated object");
    expect(() => execute(f.home, "add", [f.repo], { source: "oversized", ref: "main" })).toThrow(
      expect.objectContaining({ code: "ARCHIVE_LIMIT" }),
    );
    expect(fs.readFileSync(join(f.home, "skilltree.lock"))).toEqual(lock);
    expect(fs.readFileSync(join(f.home, "skilltree.json"))).toEqual(manifest);
    expect(readLibrarySnapshot(load(f.home), point)).toEqual(oldPoint);
    expect(fs.statSync(path).size).toBe(MAX_GIT_OBJECT_BYTES + 1);
  } finally {
    f.cleanup();
  }
});
