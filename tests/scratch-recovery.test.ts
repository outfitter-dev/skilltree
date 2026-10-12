import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fixture, install, authoritative } from "./helpers";
import { load, withLock } from "../src/state";
import { execute } from "../src/service";
import {
  createLibrarySnapshot,
  readLibrarySnapshot,
  libraryHash,
  putBlob,
} from "../src/library-backup";
import { recoverScratch } from "../src/scratch-recovery";
import {
  scratchHeader,
  scratchLine,
  readScratchJournal,
  clearScratchCache,
  MAX_SCRATCH_BYTES,
  MIN_SCRATCH_CYCLE,
} from "../src/scratch-journal";
import { storageRoot } from "../src/deployment";
import { storageWrite } from "../src/files";
const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
const journal = (home: string) => join(home, "library-scratch.jsonl");
function pad(home: string, size: number) {
  const row = {
    kind: "reserve",
    id: randomUUID(),
    key: sha("unused"),
    pid: process.pid,
    uid: process.getuid!(),
    gid: process.getgid!(),
    markerHash: sha("unused"),
    markerSize: 1,
  };
  const line = scratchLine(row),
    head = scratchHeader(home);
  fs.writeFileSync(journal(home), head + " ".repeat(size - Buffer.byteLength(head + line)) + line, {
    mode: 0o600,
  });
  clearScratchCache(home);
}
for (const state of ["empty", "partial-header", "partial-created"]) {
  test(`reviewed scratch repair restores backup/revert after ${state} and preserves old bytes`, () => {
    const f = fixture();
    try {
      install(f.home);
      const point = createLibrarySnapshot(load(f.home), "complete"),
        path = journal(f.home),
        base = fs.readFileSync(path);
      fs.writeFileSync(
        path,
        state === "empty"
          ? ""
          : state === "partial-header"
            ? '{"version":'
            : base.toString() + '{"kind":"created","id":"partial',
      );
      clearScratchCache(f.home);
      fs.writeFileSync(join(f.dest, "new-note"), "new data");
      expect(() => execute(f.home, "backup", [])).toThrow(
        expect.objectContaining({ code: "BACKUP_SCRATCH_HELD" }),
      );
      const old = fs.readFileSync(path),
        before = authoritative(f.home),
        preview = execute(f.home, "recover", [], { scratch: true, dryRun: true }) as {
          expected: string;
        };
      expect(authoritative(f.home)).toBe(before);
      expect(() =>
        execute(f.home, "recover", [], { scratch: true, expect: "0".repeat(64) }),
      ).toThrow(expect.objectContaining({ code: "SCRATCH_REPAIR_STALE" }));
      const result = execute(f.home, "recover", [], {
        scratch: true,
        expect: preview.expected,
      }) as { result: { sealed: string } };
      expect(fs.readFileSync(result.result.sealed)).toEqual(old);
      expect(readLibrarySnapshot(load(f.home), point.id)).toEqual(point);
      expect(execute(f.home, "backup", [])).toMatchObject({ result: { outcome: "BACKED_UP" } });
      fs.writeFileSync(join(f.dest, "new-note"), "even newer data");
      execute(f.home, "revert", [], {
        snapshot: point.id,
        expect: libraryHash(load(f.home)),
        quietHost: true,
      });
      expect(fs.existsSync(join(f.dest, "new-note"))).toBe(false);
      expect(fs.readFileSync(result.result.sealed)).toEqual(old);
      expect(readLibrarySnapshot(load(f.home), point.id)).toEqual(point);
    } finally {
      f.cleanup();
    }
  });
}
for (const phase of ["prepared", "sealed", "installed"] as const) {
  test(`scratch repair resumes after ${phase} with unchanged preview and intact seal`, () => {
    const f = fixture();
    try {
      install(f.home);
      createLibrarySnapshot(load(f.home), "base");
      fs.appendFileSync(journal(f.home), "partial");
      clearScratchCache(f.home);
      const bytes = fs.readFileSync(journal(f.home)),
        hash = sha(bytes),
        ctx = load(f.home);
      expect(() =>
        withLock(
          ctx,
          () =>
            recoverScratch(ctx, false, hash, (at) => {
              if (at === phase) throw new Error("stop repair");
            }),
          true,
        ),
      ).toThrow("stop repair");
      if (phase === "prepared") {
        const directory = join(f.home, "library-scratch-seals"),
          stage = join(
            directory,
            fs.readdirSync(directory).find((name) => name.endsWith(".next"))!,
          );
        const expectedBytes = fs.readFileSync(stage);
        fs.writeFileSync(stage, "unknown replacement bytes");
        expect(() => execute(f.home, "recover", [], { scratch: true, expect: hash })).toThrow(
          expect.objectContaining({ code: "SCRATCH_REPAIR_HELD" }),
        );
        expect(fs.readFileSync(stage, "utf8")).toBe("unknown replacement bytes");
        fs.writeFileSync(stage, expectedBytes.subarray(0, 30));
      }
      expect(() => execute(f.home, "backup", [])).toThrow(
        expect.objectContaining({ code: "RECOVERY_REQUIRED" }),
      );
      const before = authoritative(f.home);
      expect(execute(f.home, "recover", [], { scratch: true, dryRun: true })).toMatchObject({
        outcome: "WOULD_RESUME_SCRATCH",
      });
      expect(authoritative(f.home)).toBe(before);
      const result = execute(f.home, "recover", [], { scratch: true, expect: hash }) as {
        result: { sealed: string };
      };
      expect(fs.readFileSync(result.result.sealed)).toEqual(bytes);
      fs.writeFileSync(join(f.dest, "after"), "new");
      expect(execute(f.home, "backup", [])).toMatchObject({ result: { outcome: "BACKED_UP" } });
    } finally {
      f.cleanup();
    }
  });
}
test("repair carries unresolved ownership and preserves unknown artifacts while refusing active owners", () => {
  const f = fixture();
  try {
    install(f.home);
    createLibrarySnapshot(load(f.home), "base");
    const data = "pending payload",
      key = sha(data);
    expect(() =>
      putBlob(f.home, key, Buffer.from(data), () => {
        throw new Error("active");
      }),
    ).toThrow("active");
    expect(() => execute(f.home, "recover", [], { scratch: true, dryRun: true })).toThrow(
      expect.objectContaining({ code: "SCRATCH_OWNER_ACTIVE" }),
    );
    // The active owner's artifacts remain untouched; use a separate exited writer.
    const g = fixture();
    try {
      install(g.home);
      const point = createLibrarySnapshot(load(g.home), "point");
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          'import {putBlob} from "./src/library-backup.ts";putBlob(process.env.TEST_HOME!,process.env.TEST_HASH!,Buffer.from("pending payload"),()=>process.kill(process.pid,"SIGKILL"));',
        ],
        { env: { ...process.env, TEST_HOME: g.home, TEST_HASH: key } },
      );
      expect(child.signal).toBe("SIGKILL");
      const unknown = join(g.home, "library-blobs", "unowned.tmp");
      fs.writeFileSync(unknown, "unknown bytes");
      fs.appendFileSync(journal(g.home), "partial-created");
      clearScratchCache(g.home);
      const preview = execute(g.home, "recover", [], { scratch: true, dryRun: true }) as {
        expected: string;
        carried: number;
      };
      expect(preview.carried).toBe(1);
      execute(g.home, "recover", [], { scratch: true, expect: preview.expected });
      expect(readScratchJournal(g.home).reservations.size).toBe(1);
      expect(readScratchJournal(g.home).created.size).toBe(1);
      expect(fs.readFileSync(unknown, "utf8")).toBe("unknown bytes");
      expect(readLibrarySnapshot(load(g.home), point.id)).toEqual(point);
      fs.writeFileSync(join(g.dest, "new"), "new");
      expect(execute(g.home, "backup", [])).toMatchObject({ result: { outcome: "BACKED_UP" } });
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});
test("capacity warns, rejects an incomplete cycle before reservation, and rolls over at exact cap", () => {
  const f = fixture();
  try {
    install(f.home);
    const point = createLibrarySnapshot(load(f.home), "point");
    pad(f.home, MAX_SCRATCH_BYTES - 900000);
    expect(execute(f.home, "doctor", [])).toMatchObject({
      outcome: "OK",
      scratchCapacity: { warning: true, usable: true },
    });
    pad(f.home, MAX_SCRATCH_BYTES - MIN_SCRATCH_CYCLE + 1);
    const old = sha(fs.readFileSync(journal(f.home)));
    expect(() => putBlob(f.home, sha("new"), Buffer.from("new"))).toThrow(
      expect.objectContaining({ code: "BACKUP_LIMIT" }),
    );
    expect(sha(fs.readFileSync(journal(f.home)))).toBe(old);
    pad(f.home, MAX_SCRATCH_BYTES - MIN_SCRATCH_CYCLE);
    putBlob(f.home, sha("fits"), Buffer.from("fits"));
    expect(readScratchJournal(f.home).held).toHaveLength(0);
    pad(f.home, MAX_SCRATCH_BYTES);
    expect(execute(f.home, "doctor", [])).toMatchObject({
      outcome: "ERROR",
      scratchCapacity: { remaining: 0, usable: false },
    });
    fs.appendFileSync(journal(f.home), "x");
    expect(execute(f.home, "doctor", [])).toMatchObject({
      outcome: "ERROR",
      scratchCapacity: { remaining: -1, usable: false, warning: true },
    });
    fs.truncateSync(journal(f.home), MAX_SCRATCH_BYTES);
    const bytes = fs.readFileSync(journal(f.home)),
      preview = execute(f.home, "recover", [], { scratch: true, dryRun: true }) as {
        expected: string;
      };
    const result = execute(f.home, "recover", [], { scratch: true, expect: preview.expected }) as {
      result: { sealed: string };
    };
    expect(sha(fs.readFileSync(result.result.sealed))).toBe(sha(bytes));
    expect(readScratchJournal(f.home).capacity.usable).toBe(true);
    fs.writeFileSync(join(f.dest, "after-cap"), "after");
    expect(execute(f.home, "backup", [])).toMatchObject({ result: { outcome: "BACKED_UP" } });
    fs.writeFileSync(join(f.dest, "after-cap"), "newer");
    execute(f.home, "revert", [], {
      snapshot: point.id,
      expect: libraryHash(load(f.home)),
      quietHost: true,
    });
    expect(fs.existsSync(join(f.dest, "after-cap"))).toBe(false);
    expect(readLibrarySnapshot(load(f.home), point.id)).toEqual(point);
  } finally {
    f.cleanup();
  }
});
test("doctor exposes retained revert stage without a receipt and storage errors carry their paths", () => {
  const f = fixture();
  try {
    install(f.home);
    createLibrarySnapshot(load(f.home), "point");
    const storage = storageRoot(load(f.home)),
      orphan = join(storage, "library-" + randomUUID());
    fs.mkdirSync(join(orphan, "stage"), { recursive: true });
    fs.writeFileSync(join(orphan, "stage", "unknown"), "keep");
    const before = authoritative(f.home),
      doctor = execute(f.home, "doctor", []) as {
        outcome: string;
        retainedDirectories: { held: { root: string; reason: string }[] };
      };
    expect(doctor.outcome).toBe("ERROR");
    expect(
      doctor.retainedDirectories.held.some(
        (h) =>
          h.root === orphan &&
          h.reason.includes("no collection receipt") &&
          !h.reason.includes("ENOENT"),
      ),
    ).toBe(true);
    expect(authoritative(f.home)).toBe(before);
    expect(fs.readFileSync(join(orphan, "stage", "unknown"), "utf8")).toBe("keep");
    for (const code of ["EFBIG", "ENOSPC", "EDQUOT"]) {
      expect(() =>
        storageWrite(orphan, () => {
          throw Object.assign(new Error("raw"), { code });
        }),
      ).toThrow(
        expect.objectContaining({
          code: "STORAGE_" + code,
          message: expect.stringContaining(orphan),
        }),
      );
    }
  } finally {
    f.cleanup();
  }
});
test.skipIf(process.platform !== "linux")(
  "actual 2KB short write reports EFBIG and repaired backup/revert succeeds",
  () => {
    const f = fixture();
    try {
      install(f.home);
      const point = createLibrarySnapshot(load(f.home), "point");
      pad(f.home, 1600);
      const code =
        'import {putBlob} from "./src/library-backup.ts";process.on("SIGXFSZ",()=>{});try{putBlob(process.env.TEST_HOME!,process.env.TEST_HASH!,Buffer.from("short"));console.log(JSON.stringify({code:"unexpected-success"}));}catch(e){console.log(JSON.stringify({code:e.code,message:e.message}));}';
      const child = spawnSync(
        "bash",
        ["-c", 'ulimit -f 2; exec "$1" -e "$2"', "short-write", process.execPath, code],
        { encoding: "utf8", env: { ...process.env, TEST_HOME: f.home, TEST_HASH: sha("short") } },
      );
      expect(child.status).toBe(0);
      const failure = JSON.parse(child.stdout);
      expect(failure.code).toBe("STORAGE_EFBIG");
      expect(failure.message).toContain(journal(f.home));
      expect(fs.statSync(journal(f.home)).size).toBe(2048);
      expect(
        readScratchJournal(f.home).held.some((h) =>
          h.reason.includes("partial creation checkpoint"),
        ),
      ).toBe(true);
      const preview = execute(f.home, "recover", [], { scratch: true, dryRun: true }) as {
        expected: string;
      };
      execute(f.home, "recover", [], { scratch: true, expect: preview.expected });
      fs.writeFileSync(join(f.dest, "new"), "new");
      execute(f.home, "backup", []);
      fs.writeFileSync(join(f.dest, "new"), "newer");
      execute(f.home, "revert", [], {
        snapshot: point.id,
        expect: libraryHash(load(f.home)),
        quietHost: true,
      });
      expect(readLibrarySnapshot(load(f.home), point.id)).toEqual(point);
    } finally {
      f.cleanup();
    }
  },
);
