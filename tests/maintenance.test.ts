import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execute } from "../src/service";
import { load, withLock } from "../src/state";
import { sourcePath } from "../src/git";
import { storageRoot } from "../src/deployment";
import { atomicJson } from "../src/files";
import { checkpointScratch, sourceFailure } from "../src/maintenance";
import { fixture, install, editBody, commit, approveApply } from "./helpers";

test("host metadata holds only the affected skill and existing configuration migrates to Grok", () => {
  const f = fixture();
  try {
    const other = join(f.repo, ".agents/skills/other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
      join(other, "SKILL.md"),
      "---\nname: other\ndescription: Other\n---\nContent\n",
    );
    commit(f.repo, "second skill");
    execute(f.home, "sync", []);
    install(f.home);
    execute(f.home, "select", ["upstream"], {
      path: ".agents/skills/other",
      id: "other",
      install: true,
      reason: "fixture",
    });
    fs.writeFileSync(join(f.dest, "helper/runs.json"), '{"host":true}');
    fs.appendFileSync(join(other, "SKILL.md"), "upstream update\n");
    commit(f.repo, "update");
    const result = execute(f.home, "sync", []) as {
      result: {
        sources: { outcome: string }[];
        entries: { id: string; outcome: string; candidate: unknown }[];
      };
    };
    expect(result.result.sources[0]!.outcome).toBe("STAGED");
    expect(result.result.entries.find((e) => e.id === "helper")!.outcome).toBe("HELD");
    expect(result.result.entries.find((e) => e.id === "other")!.candidate).not.toBeNull();
    const before = fs.readFileSync(join(f.home, "skilltree.json"), "utf8");
    execute(f.home, "configure", [], { adapter: "grok", dryRun: true });
    expect(fs.readFileSync(join(f.home, "skilltree.json"), "utf8")).toBe(before);
    execute(f.home, "configure", [], { adapter: "grok" });
    expect(load(f.home).manifest.hostMetadata).toEqual(["workflow.md", "runs.json"]);
    expect(execute(f.home, "verify", [])).toMatchObject({ outcome: "CURRENT" });
    expect(fs.readFileSync(join(f.dest, "helper/runs.json"), "utf8")).toBe('{"host":true}');
  } finally {
    f.cleanup();
  }
});
test("report-recognized completed legacy storage migrates intact while unknown folders hold", () => {
  const f = fixture();
  try {
    install(f.home);
    const uuid = "4e800ae6-51ad-4bfe-8747-624e50289601",
      legacy = join(f.dest, ".skilltree-transaction-" + uuid);
    fs.mkdirSync(legacy);
    fs.cpSync(join(f.dest, "helper"), join(legacy, "backup"), { recursive: true });
    fs.writeFileSync(join(legacy, "notes"), "unknown notes remain");
    fs.writeFileSync(join(legacy, "backup", "runs.json"), "unique legacy host history");
    execute(f.home, "configure", [], { adapter: "grok" });
    atomicJson(join(f.home, "reports", "legacy.json"), {
      result: { outcome: "UPDATED", id: "helper", retainedBackup: join(legacy, "backup") },
    });
    const unknown = join(f.dest, ".skilltree-transaction-11111111-1111-4111-8111-111111111111");
    fs.mkdirSync(unknown);
    fs.writeFileSync(join(unknown, "notes"), "hold");
    execute(f.home, "migrate-storage", [], { dryRun: true });
    expect(fs.existsSync(legacy)).toBe(true);
    const result = execute(f.home, "migrate-storage", []) as {
      result: { moved: string[]; held: unknown[] };
    };
    expect(result.result.moved).toHaveLength(1);
    expect(result.result.held).toHaveLength(1);
    expect(fs.readFileSync(join(storageRoot(load(f.home)), uuid, "notes"), "utf8")).toBe(
      "unknown notes remain",
    );
    expect(fs.existsSync(legacy)).toBe(false);
    const relocated = join(storageRoot(load(f.home)), uuid);
    expect(
      JSON.parse(fs.readFileSync(join(relocated, "owner.json"), "utf8")).files["backup/runs.json"],
    ).toBeUndefined();
    fs.unlinkSync(join(relocated, "notes"));
    execute(f.home, "compact", [], { retainBackups: 0 });
    expect(fs.readFileSync(join(storageRoot(load(f.home)), uuid, "backup/runs.json"), "utf8")).toBe(
      "unique legacy host history",
    );
    expect(fs.existsSync(unknown)).toBe(true);
    expect(execute(f.home, "doctor", [])).toMatchObject({
      outcome: "OK",
      warnings: expect.arrayContaining([expect.stringContaining("legacy folder")]),
    });
  } finally {
    f.cleanup();
  }
});
test("explicit backup retention bounds owned data and preserves modified backups", () => {
  const f = fixture();
  try {
    install(f.home);
    for (let i = 0; i < 4; i++) {
      fs.appendFileSync(join(f.skill, "SKILL.md"), `Update ${i}\n`);
      commit(f.repo, `update${i}`);
      execute(f.home, "sync", []);
      approveApply(f.home);
    }
    const root = storageRoot(load(f.home)),
      dirs = fs.readdirSync(root).filter((n) => n !== "owner.json");
    const changed = join(root, dirs[0]!);
    fs.writeFileSync(join(changed, "unknown-work"), "preserve");
    const entries = JSON.stringify(load(f.home).lock.entries);
    const dry = execute(f.home, "compact", [], { retainBackups: 1, dryRun: true }) as {
      candidates: unknown[];
    };
    expect(dry.candidates.length).toBeGreaterThan(0);
    expect(fs.readdirSync(root).length).toBe(dirs.length + 1);
    const real = execute(f.home, "compact", [], { retainBackups: 1 }) as {
      result: { held: unknown[] };
    };
    expect(real.result.held.length).toBeGreaterThan(0);
    expect(fs.readFileSync(join(changed, "unknown-work"), "utf8")).toBe("preserve");
    expect(JSON.stringify(load(f.home).lock.entries)).toBe(entries);
    expect(fs.readdirSync(root).filter((n) => n !== "owner.json").length).toBeLessThan(dirs.length);
  } finally {
    f.cleanup();
  }
});
test("retention never adopts another collection's backup", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(f.skill, "Last line", "Next");
    commit(f.repo, "next");
    execute(f.home, "sync", []);
    approveApply(f.home);
    const root = storageRoot(load(f.home)),
      dir = fs
        .readdirSync(root)
        .find((name) => name !== "owner.json" && fs.existsSync(join(root, name, "backup")))!,
      marker = join(root, dir, "owner.json");
    const record = JSON.parse(fs.readFileSync(marker, "utf8"));
    record.collection = join(f.root, "other-collection");
    atomicJson(marker, record);
    execute(f.home, "compact", [], { retainBackups: 0 });
    expect(fs.existsSync(join(root, dir, "backup/SKILL.md"))).toBe(true);
  } finally {
    f.cleanup();
  }
});
test("archive-backed cache compaction removes retired Git metadata but holds unknown work", () => {
  const f = fixture();
  try {
    install(f.home);
    const first = load(f.home).lock.sources[0]!,
      old = sourcePath(f.home, first);
    editBody(f.skill, "Last line", "Next");
    commit(f.repo, "next");
    execute(f.home, "sync", []);
    const second = load(f.home).lock.sources[0]!,
      unknown = sourcePath(f.home, second);
    editBody(f.skill, "Next", "Final");
    commit(f.repo, "final");
    execute(f.home, "sync", []);
    fs.writeFileSync(join(unknown, ".git", "user-notes"), "unique metadata");
    execute(f.home, "compact", [], { caches: true, dryRun: true });
    expect(fs.existsSync(join(old, ".git"))).toBe(true);
    execute(f.home, "compact", [], { caches: true });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.readFileSync(join(unknown, ".git", "user-notes"), "utf8")).toBe("unique metadata");
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});
test("safe source error categories never echo private diagnostics", () => {
  expect(sourceFailure({ stderr: Buffer.from("Could not resolve host private.example") })).toBe(
    "SOURCE_NETWORK",
  );
  expect(sourceFailure({ stderr: Buffer.from("Authentication failed for secret URL") })).toBe(
    "SOURCE_AUTH",
  );
  expect(sourceFailure({ stderr: Buffer.from("couldn't find remote ref missing") })).toBe(
    "SOURCE_REF",
  );
  expect(sourceFailure({ code: "ENOSPC" })).toBe("SOURCE_IO");
});
test("owned stale scratch cleanup is isolated and preserves unknown notes", () => {
  const f = fixture();
  try {
    const runtime = load(f.home).runtime,
      stages = join(runtime, "stages"),
      root = join(stages, "4e800ae6-51ad-4bfe-8747-624e50289601"),
      unknown = join(stages, "11111111-1111-4111-8111-111111111111");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(join(root, "owned"), "cache");
    checkpointScratch(root);
    let record = JSON.parse(fs.readFileSync(join(root, "owner.json"), "utf8"));
    record.pid = 2147483647;
    atomicJson(join(root, "owner.json"), record);
    fs.mkdirSync(unknown);
    fs.writeFileSync(join(unknown, "owned"), "cache");
    checkpointScratch(unknown);
    record = JSON.parse(fs.readFileSync(join(unknown, "owner.json"), "utf8"));
    record.pid = 2147483647;
    atomicJson(join(unknown, "owner.json"), record);
    fs.writeFileSync(join(unknown, "notes"), "unknown");
    execute(f.home, "compact", [], { scratch: true });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readFileSync(join(unknown, "notes"), "utf8")).toBe("unknown");
    expect(runtime.startsWith(join(f.root, "runtime"))).toBe(true);
  } finally {
    f.cleanup();
  }
});
test("doctor recommends check-only restore only for verified archives", () => {
  const f = fixture();
  try {
    const source = load(f.home).lock.sources[0]!;
    fs.rmSync(sourcePath(f.home, source), { recursive: true });
    const result = execute(f.home, "doctor", []) as { issues: string[] };
    expect(result.issues.join(" ")).toContain("restore --dry-run");
  } finally {
    f.cleanup();
  }
});
test("installer preflights occupied launchers and restores whole-prefix loss from durable state", () => {
  const f = fixture();
  try {
    const node = process.env.SKILLTREE_DEMO_NODE ?? Bun.which("node")!,
      artifact = join(f.root, "artifact.mjs");
    fs.writeFileSync(artifact, 'console.log("runner")\n');
    const sha = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"),
      prefix = join(f.root, "runner-prefix"),
      state = join(f.root, "runner-state"),
      installer = resolve("bin/install.mjs");
    const run = (args: string[]) =>
      Bun.spawnSync([node, installer, ...args], { stdout: "pipe", stderr: "pipe" });
    fs.mkdirSync(join(prefix, "bin"), { recursive: true });
    fs.writeFileSync(join(prefix, "bin/skilltree"), "occupied");
    const args = [
      "--prefix",
      prefix,
      "--state-home",
      state,
      "--artifact",
      artifact,
      "--sha256",
      sha,
      "--node",
      node,
    ];
    expect(run(args).exitCode).toBe(1);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.existsSync(join(prefix, "dist"))).toBe(false);
    fs.rmSync(prefix, { recursive: true });
    expect(run(args).exitCode).toBe(0);
    fs.rmSync(prefix, { recursive: true });
    expect(run(["--prefix", prefix, "--state-home", state, "--restore"]).exitCode).toBe(0);
    expect(
      Bun.spawnSync([join(prefix, "bin/skilltree")], {
        stdout: "pipe",
        stderr: "pipe",
      }).stdout.toString(),
    ).toContain("runner");
  } finally {
    f.cleanup();
  }
});
test("Grok configuration rejects destination aliases and records explicit storage placement", () => {
  const f = fixture();
  try {
    const alias = join(f.root, "alias");
    fs.symlinkSync(f.dest, alias);
    expect(() =>
      execute(join(f.root, "new-state"), "init", [], {
        destination: alias,
        exclusive: true,
        adapter: "grok",
        runtimeRoot: join(f.root, "other-runtime"),
      }),
    ).toThrow(expect.objectContaining({ code: "UNSAFE_PATH" }));
    const chosen = join(f.root, "transactions");
    execute(f.home, "configure", [], { adapter: "grok", transactionStorage: chosen });
    expect(storageRoot(load(f.home))).toBe(chosen);
    install(f.home);
    expect(fs.existsSync(join(chosen, "owner.json"))).toBe(true);
  } finally {
    f.cleanup();
  }
});

(process.platform === "linux" ? test : test.skip)(
  "runtime migration bridges the previous kernel inode and preserves contention",
  () => {
    const f = fixture();
    try {
      const manifest = load(f.home).manifest;
      manifest.lockBackend = "flock";
      atomicJson(join(f.home, "skilltree.json"), manifest);
      const old = load(f.home);
      withLock(old, () => {});
      const oldHome = join(f.root, "old-home");
      fs.cpSync(f.home, oldHome, { recursive: true });
      execute(f.home, "configure", [], {
        runtimeRoot: join(f.root, "new-runtime"),
        lockBackend: "flock",
      });
      const current = load(f.home);
      expect(current.manifest.legacyRuntime).toBe(old.runtime);
      expect(current.manifest.legacyLockName).toBe("sync.lock");
      const code = `import {load,withLock} from './src/state.ts';try{withLock(load(process.argv[1]),()=>{});console.log('ACQUIRED')}catch(e){console.log(e.code)}`;
      const child = () =>
        Bun.spawnSync([process.execPath, "-e", code, oldHome], {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        });
      withLock(current, () => expect(child().stdout.toString()).toContain("LOCKED"));
      expect(child().stdout.toString()).toContain("ACQUIRED");
    } finally {
      f.cleanup();
    }
  },
);
