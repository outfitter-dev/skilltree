import { inventory } from "../src/ownership";
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fixture, install, authoritative } from "./helpers";
import {
  directoryTree,
  libraryHash,
  createLibrarySnapshot,
  readLibrarySnapshot,
  revertLibrary,
  libraryPending,
} from "../src/library-backup";
import { mountId, checkedPython } from "../src/filesystem-capabilities";
import { load, withLock } from "../src/state";
import { execute } from "../src/service";
import { compactLibrary } from "../src/library-maintenance";
import { createHash, randomUUID } from "node:crypto";
import { storageRoot } from "../src/deployment";

test("Linux mount identity distinguishes escaped mountpoints and same-device bind mounts", () => {
  const table =
    "39 1 0:39 / / rw - overlay overlay rw\n40 39 0:39 / /skills/bind rw - overlay overlay rw\n41 39 0:39 / /with\\040space rw - overlay overlay rw\n";
  expect(mountId("/skills/helper", table)).toBe("39");
  expect(mountId("/skills/bind/file", table)).toBe("40");
  expect(mountId("/with space/file", table)).toBe("41");
  expect(mountId("/skills/binding", table)).toBe("39");
});

test("doctor checks unsupported outside-lock entries and leaves durable state unchanged", () => {
  const f = fixture();
  try {
    install(f.home);
    fs.symlinkSync("missing", join(f.dest, "dangling"));
    const before = authoritative(f.home);
    const result = execute(f.home, "doctor", []) as { outcome: string; issues: string[] };
    expect(result.outcome).toBe("ERROR");
    expect(result.issues.join("\n")).toContain(join(f.dest, "dangling"));
    expect(() => directoryTree(f.home, f.dest)).toThrow(
      expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
    );
    expect(authoritative(f.home)).toBe(before);
    fs.unlinkSync(join(f.dest, "dangling"));
    const legacy = join(f.dest, ".skilltree-transaction-unknown");
    fs.mkdirSync(legacy);
    fs.writeFileSync(join(legacy, "notes"), "unowned");
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "ERROR" });
  } finally {
    f.cleanup();
  }
});

test.skipIf(process.platform !== "linux")(
  "missing absolute Python fails capability checks; PATH spoof cannot bypass xattrs",
  () => {
    expect(() => checkedPython("/nonexistent/skilltree-python3")).toThrow(
      expect.objectContaining({ code: "BACKUP_CAPABILITY" }),
    );
    const f = fixture(),
      oldPath = process.env.PATH;
    try {
      const tools = join(f.root, "fake-tools"),
        file = join(f.dest, "host-file");
      fs.mkdirSync(tools);
      fs.writeFileSync(file, "host");
      execFileSync(checkedPython().path, [
        "-I",
        "-c",
        "import os,sys;os.setxattr(sys.argv[1],'user.skilltree-test',b'x')",
        file,
      ]);
      fs.writeFileSync(join(tools, "python3"), "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n", {
        mode: 0o755,
      });
      process.env.PATH = tools + ":" + oldPath;
      const before = authoritative(f.home),
        result = execute(f.home, "doctor", []) as {
          outcome: string;
          issues: string[];
          metadataInspector: { path: string; sha256: string };
        };
      expect(result.outcome).toBe("ERROR");
      expect(result.issues.join("\n")).toContain(file);
      expect(result.metadataInspector.path).toBe(fs.realpathSync("/usr/bin/python3"));
      expect(result.metadataInspector.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(() => directoryTree(f.home, f.dest)).toThrow(
        expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
      );
      expect(authoritative(f.home)).toBe(before);
    } finally {
      process.env.PATH = oldPath;
      f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "direct Linux inspector detects real xattrs and POSIX ACLs without attr/acl commands",
  () => {
    const f = fixture();
    try {
      const file = join(f.dest, "host-file");
      fs.writeFileSync(file, "host");
      execFileSync(checkedPython().path, [
        "-I",
        "-c",
        "import os,sys;os.setxattr(sys.argv[1],'user.skilltree-test',b'x')",
        file,
      ]);
      expect(() => directoryTree(f.home, f.dest)).toThrow(
        expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
      );
      execFileSync(checkedPython().path, [
        "-I",
        "-c",
        "import os,sys;os.removexattr(sys.argv[1],'user.skilltree-test')",
        file,
      ]);
      // Linux ACL xattr v2: USER_OBJ, named USER, GROUP_OBJ, MASK, OTHER.
      execFileSync(checkedPython().path, [
        "-I",
        "-c",
        "import os,sys,struct;v=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*x) for x in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,4,0xffffffff)]);os.setxattr(sys.argv[1],'system.posix_acl_access',v)",
        file,
      ]);
      expect(() => directoryTree(f.home, f.dest)).toThrow(
        expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
      );
      execFileSync(checkedPython().path, [
        "-I",
        "-c",
        "import os,sys;os.removexattr(sys.argv[1],'system.posix_acl_access')",
        file,
      ]);
      expect(directoryTree(f.home, f.dest).rows["host-file"]).toBeDefined();
    } finally {
      f.cleanup();
    }
  },
);

test("actual directory revert requires a quiet-host attestation before any backup or swap", () => {
  const f = fixture();
  try {
    install(f.home);
    const point = createLibrarySnapshot(load(f.home), "target");
    fs.writeFileSync(join(f.dest, "newer"), "keep");
    const hash = libraryHash(load(f.home)),
      before = authoritative(f.home);
    expect(() => execute(f.home, "revert", [], { snapshot: point.id, expect: hash })).toThrow(
      expect.objectContaining({ code: "HOST_NOT_QUIET" }),
    );
    expect(authoritative(f.home)).toBe(before);
    expect(libraryHash(load(f.home))).toBe(hash);
  } finally {
    f.cleanup();
  }
});

test("explicit retained-directory policy removes only proven copies and preserves all recovery points", () => {
  const f = fixture();
  try {
    install(f.home);
    const point = createLibrarySnapshot(load(f.home), "older");
    fs.writeFileSync(join(f.dest, "later"), "preserve");
    const result = execute(f.home, "revert", [], {
      snapshot: point.id,
      expect: libraryHash(load(f.home)),
      quietHost: true,
    }) as { result: { retainedPrior: string; currentRecoveryPoint: string } };
    const ctx = load(f.home),
      prior = result.result.retainedPrior;
    const preview = compactLibrary(ctx, { retainedDirectories: true, dryRun: true });
    expect(preview.candidates).toHaveLength(1);
    expect(fs.existsSync(prior)).toBe(true);
    fs.writeFileSync(join(prior, "unknown-note"), "keep unknown");
    expect(compactLibrary(ctx, { retainedDirectories: true }).held).toHaveLength(1);
    expect(fs.readFileSync(join(prior, "unknown-note"), "utf8")).toBe("keep unknown");
    fs.unlinkSync(join(prior, "unknown-note"));
    expect(compactLibrary(ctx, { retainedDirectories: true }).candidates).toHaveLength(1);
    expect(fs.existsSync(prior)).toBe(false);
    expect(readLibrarySnapshot(ctx, point.id).id).toBe(point.id);
    expect(
      readLibrarySnapshot(ctx, result.result.currentRecoveryPoint).tree.rows.later,
    ).toBeDefined();
    const unowned = join(storageRoot(ctx), "library-" + randomUUID());
    fs.mkdirSync(unowned);
    expect(compactLibrary(ctx, { retainedDirectories: true }).held).toHaveLength(1);
    expect(fs.existsSync(unowned)).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("backup scratch cleanup requires an exited owner and exact checkpointed temp bytes", () => {
  const f = fixture();
  try {
    const root = join(f.home, "library-blobs");
    fs.mkdirSync(root, { recursive: true });
    const key = createHash("sha256").update("bytes").digest("hex"),
      temp = join(root, `${key}.bin.${randomUUID()}.tmp`);
    const killed = spawnSync(
      process.execPath,
      [
        "-e",
        `import * as fs from "node:fs"; import { rememberBlobTemp } from "./src/library-maintenance.ts"; const path=process.env.SKILLTREE_TEST_TEMP!;fs.writeFileSync(path,"bytes",{mode:0o600});rememberBlobTemp(process.env.SKILLTREE_TEST_HOME!,path,process.env.SKILLTREE_TEST_HASH!);process.kill(process.pid,"SIGKILL");`,
      ],
      {
        env: {
          ...process.env,
          SKILLTREE_TEST_TEMP: temp,
          SKILLTREE_TEST_HOME: f.home,
          SKILLTREE_TEST_HASH: key,
        },
      },
    );
    expect(killed.signal).toBe("SIGKILL");
    const marker = join(f.home, "library-temp-records", temp.split("/").at(-1)! + ".json");
    const record = JSON.parse(fs.readFileSync(marker, "utf8"));
    expect(record.pid).toBe(killed.pid);
    fs.writeFileSync(temp, "partial");
    expect(compactLibrary(load(f.home), { backupScratch: true }).held).toHaveLength(1);
    fs.writeFileSync(temp, "bytes");
    expect(
      compactLibrary(load(f.home), { backupScratch: true, dryRun: true }).candidates,
    ).toHaveLength(1);
    expect(fs.existsSync(temp)).toBe(true);
    expect(compactLibrary(load(f.home), { backupScratch: true }).candidates).toHaveLength(1);
    expect(fs.existsSync(temp)).toBe(false);
  } finally {
    f.cleanup();
  }
});

test.skipIf(process.env.SKILLTREE_OVERLAY_FIXTURE !== "1")(
  "real xino-off overlayfs permits split st_dev backup/apply/revert and rejects nested bind mounts",
  () => {
    const f = fixture();
    let bound = false;
    try {
      const file = join(f.dest, "host");
      fs.writeFileSync(file, "host metadata");
      expect(fs.lstatSync(f.dest).dev).not.toBe(fs.lstatSync(file).dev);
      console.log(
        `overlay proof: directory st_dev=${fs.lstatSync(f.dest).dev}; file st_dev=${fs.lstatSync(file).dev}; mount=${mountId(file)}`,
      );
      if (process.env.SKILLTREE_BASELINE_CLI) {
        const old = spawnSync(
          process.env.SKILLTREE_DEMO_NODE ?? "node",
          [process.env.SKILLTREE_BASELINE_CLI, "backup", "--home", f.home],
          { encoding: "utf8" },
        );
        expect(old.status).toBe(1);
        expect(JSON.parse(old.stderr).outcome).toBe("BACKUP_UNSUPPORTED");
        console.log(
          "baseline b37eb38: BACKUP_UNSUPPORTED; current unchanged source: backup/apply/revert supported",
        );
      }
      const point = createLibrarySnapshot(load(f.home), "overlay");
      install(f.home);
      expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
      expect(execute(f.home, "revert", [], { snapshot: point.id, dryRun: true })).toMatchObject({
        outcome: "WOULD_REVERT",
      });
      execute(f.home, "revert", [], {
        snapshot: point.id,
        expect: libraryHash(load(f.home)),
        quietHost: true,
      });
      expect(fs.readFileSync(file, "utf8")).toBe("host metadata");
      const source = join(f.root, "bind-source"),
        target = join(f.dest, "bind-target");
      fs.mkdirSync(source);
      fs.mkdirSync(target);
      expect(fs.statSync(source).dev).toBe(fs.statSync(target).dev);
      execFileSync("mount", ["--bind", source, target]);
      bound = true;
      expect(() => directoryTree(f.home, f.dest)).toThrow(
        expect.objectContaining({ code: "BACKUP_MOUNT" }),
      );
    } finally {
      if (bound) execFileSync("umount", [join(f.dest, "bind-target")]);
      f.cleanup();
    }
  },
);

test("a host-recreated directory during the rename gap holds without losing either directory", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home),
      point = createLibrarySnapshot(ctx, "older");
    const before = libraryHash(ctx);
    expect(() =>
      withLock(ctx, () =>
        revertLibrary(ctx, point.id, before, false, true, () => {
          fs.mkdirSync(f.dest);
          fs.writeFileSync(join(f.dest, "host-newer"), "retain host data");
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "REVERT_STALE" }));
    expect(fs.readFileSync(join(f.dest, "host-newer"), "utf8")).toBe("retain host data");
    expect(libraryPending(ctx)).toBe(true);
    expect(() => execute(f.home, "recover", [], { quietHost: true })).toThrow(
      expect.objectContaining({ code: "DRIFT" }),
    );
    const preview = execute(f.home, "recover", [], { dryRun: true, keepCurrent: true }) as {
      expected: string;
    };
    const result = execute(f.home, "recover", [], {
      quietHost: true,
      keepCurrent: true,
      expect: preview.expected,
    }) as { result: { retainedPrior: string; currentRecoveryPoint: string } };
    expect(fs.existsSync(join(result.result.retainedPrior, "helper/SKILL.md"))).toBe(true);
    expect(
      readLibrarySnapshot(load(f.home), result.result.currentRecoveryPoint).tree.rows["host-newer"],
    ).toBeDefined();
    expect(fs.readFileSync(join(f.dest, "host-newer"), "utf8")).toBe("retain host data");
  } finally {
    f.cleanup();
  }
});

test("pre-write durable intent cleans empty and partial prefixes after real process death", () => {
  const f = fixture();
  try {
    for (const amount of [0, 3, 8]) {
      const payload = "payload" + amount,
        key = createHash("sha256").update(payload).digest("hex");
      const killed = spawnSync(
        process.execPath,
        [
          "-e",
          `import * as fs from "node:fs";import {putBlob} from "./src/library-backup.ts";const data=Buffer.from(process.env.SKILLTREE_TEST_DATA!);putBlob(process.env.SKILLTREE_TEST_HOME!,process.env.SKILLTREE_TEST_HASH!,data,(path)=>{if(Number(process.env.SKILLTREE_TEST_AMOUNT))fs.writeFileSync(path,data.subarray(0,Number(process.env.SKILLTREE_TEST_AMOUNT)));process.kill(process.pid,"SIGKILL");});`,
        ],
        {
          env: {
            ...process.env,
            SKILLTREE_TEST_HOME: f.home,
            SKILLTREE_TEST_DATA: payload,
            SKILLTREE_TEST_HASH: key,
            SKILLTREE_TEST_AMOUNT: String(amount),
          },
        },
      );
      expect(killed.signal).toBe("SIGKILL");
      const before = authoritative(f.home),
        preview = compactLibrary(load(f.home), { backupScratch: true, dryRun: true });
      expect(preview.candidates).toHaveLength(1);
      expect(preview.held).toHaveLength(0);
      expect(authoritative(f.home)).toBe(before);
      expect(compactLibrary(load(f.home), { backupScratch: true }).held).toHaveLength(0);
      expect(
        fs.readdirSync(join(f.home, "library-blobs")).filter((n) => n.endsWith(".tmp")),
      ).toHaveLength(0);
      expect(fs.readdirSync(join(f.home, "library-temp-records"))).toHaveLength(0);
    }
    const unknown = join(
      f.home,
      "library-blobs",
      `${createHash("sha256").update("unknown").digest("hex")}.bin.${randomUUID()}.tmp`,
    );
    fs.writeFileSync(unknown, "unknown data", { mode: 0o600 });
    expect(compactLibrary(load(f.home), { backupScratch: true }).held[0]?.reason).toContain(
      "No complete ownership intent",
    );
    expect(fs.readFileSync(unknown, "utf8")).toBe("unknown data");
    const record = join(f.home, "library-temp-records", "orphan.json.old.tmp");
    fs.writeFileSync(record, "unknown partial record");
    expect(
      compactLibrary(load(f.home), { backupScratch: true }).held.some(
        (h) => h.root === record && h.reason.includes("retained for inspection"),
      ),
    ).toBe(true);
    expect(fs.readFileSync(record, "utf8")).toBe("unknown partial record");
  } finally {
    f.cleanup();
  }
});

test("recover dry-run abort leaves the entire durable state and unfinished receipt unchanged", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home),
      target = createLibrarySnapshot(ctx, "target");
    fs.writeFileSync(join(f.dest, "later"), "keep current");
    expect(() =>
      withLock(ctx, () =>
        revertLibrary(ctx, target.id, libraryHash(ctx), false, true, undefined, undefined, () => {
          throw new Error("intent interruption");
        }),
      ),
    ).toThrow("intent interruption");
    const before = createHash("sha256").update(authoritative(f.home)).digest("hex"),
      files = inventory(f.home);
    const markers = fs.readdirSync(join(f.home, "library-retained"));
    expect(markers).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(join(f.home, "library-retained", markers[0]!), "utf8")).finished,
    ).toBe(false);
    expect(execute(f.home, "recover", [], { dryRun: true })).toMatchObject({
      outcome: "WOULD_ABORT",
    });
    expect(createHash("sha256").update(authoritative(f.home)).digest("hex")).toBe(before);
    expect(inventory(f.home)).toEqual(files);
    expect(
      JSON.parse(fs.readFileSync(join(f.home, "library-retained", markers[0]!), "utf8")).finished,
    ).toBe(false);
    expect(execute(f.home, "recover", [], { quietHost: true })).toMatchObject({
      result: { outcome: "RECOVERED" },
    });
  } finally {
    f.cleanup();
  }
});

test("backup reports distinct permission, hardlink and size-limit causes", () => {
  const f = fixture();
  try {
    const file = join(f.dest, "unsupported");
    fs.writeFileSync(file, "x");
    fs.chmodSync(file, 0o4755);
    expect(() => directoryTree(f.home, f.dest)).toThrow(
      expect.objectContaining({ code: "BACKUP_PERMISSIONS" }),
    );
    fs.chmodSync(file, 0o644);
    fs.linkSync(file, join(f.dest, "hardlink"));
    expect(() => directoryTree(f.home, f.dest)).toThrow(
      expect.objectContaining({ code: "BACKUP_HARDLINK" }),
    );
    fs.unlinkSync(join(f.dest, "hardlink"));
    fs.truncateSync(file, 10000001);
    expect(() => directoryTree(f.home, f.dest)).toThrow(
      expect.objectContaining({ code: "BACKUP_LIMIT" }),
    );
  } finally {
    f.cleanup();
  }
});

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "backup reports foreign owner distinctly on an isolated root fixture",
  () => {
    const f = fixture();
    try {
      const file = join(f.dest, "foreign");
      fs.writeFileSync(file, "x");
      fs.chownSync(file, 12345, 12345);
      expect(() => directoryTree(f.home, f.dest)).toThrow(
        expect.objectContaining({ code: "BACKUP_OWNER" }),
      );
    } finally {
      f.cleanup();
    }
  },
);
