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
import { mountId } from "../src/filesystem-capabilities";
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
  "doctor reports missing Python metadata capability without changing state",
  () => {
    const f = fixture(),
      path = process.env.PATH;
    try {
      const before = authoritative(f.home);
      const tools = join(f.root, "no-tools");
      fs.mkdirSync(tools);
      process.env.PATH = tools;
      const result = execute(f.home, "doctor", []) as { outcome: string; issues: string[] };
      expect(result.outcome).toBe("ERROR");
      expect(result.issues.join("\n")).toContain("Python 3");
      expect(authoritative(f.home)).toBe(before);
    } finally {
      process.env.PATH = path;
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
      execFileSync("python3", [
        "-I",
        "-c",
        "import os,sys;os.setxattr(sys.argv[1],'user.skilltree-test',b'x')",
        file,
      ]);
      expect(() => directoryTree(f.home, f.dest)).toThrow(
        expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
      );
      execFileSync("python3", [
        "-I",
        "-c",
        "import os,sys;os.removexattr(sys.argv[1],'user.skilltree-test')",
        file,
      ]);
      // Linux ACL xattr v2: USER_OBJ, named USER, GROUP_OBJ, MASK, OTHER.
      execFileSync("python3", [
        "-I",
        "-c",
        "import os,sys,struct;v=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*x) for x in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,4,0xffffffff)]);os.setxattr(sys.argv[1],'system.posix_acl_access',v)",
        file,
      ]);
      expect(() => directoryTree(f.home, f.dest)).toThrow(
        expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
      );
      execFileSync("python3", [
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
        expect.objectContaining({ code: "BACKUP_UNSUPPORTED" }),
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
