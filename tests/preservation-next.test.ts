import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execute } from "../src/service";
import { load } from "../src/state";
import { atomicJson } from "../src/files";
import { sourcePath, git } from "../src/git";
import { fixture, install, editBody, commit, approveApply } from "./helpers";

test("changed revisions retain archives but retire only verified generated worktree bytes", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.repo, "large-support"), "unchanged\n".repeat(10000));
    commit(f.repo, "large shared blob");
    execute(f.home, "sync", []);
    install(f.home);
    const first = load(f.home).lock.sources[0]!;
    const firstRoot = sourcePath(f.home, first);
    for (let i = 0; i < 3; i++) {
      editBody(f.skill, i ? `Revision ${i - 1}` : "Last line", `Revision ${i}`);
      commit(f.repo, `revision ${i}`);
      execute(f.home, "sync", []);
    }
    const current = load(f.home).lock.sources[0]!;
    expect(fs.existsSync(join(firstRoot, "large-support"))).toBe(false);
    expect(fs.readFileSync(join(sourcePath(f.home, current), "large-support"), "utf8")).toContain(
      "unchanged",
    );
    const oid = git(sourcePath(f.home, current), ["rev-parse", "HEAD:large-support"]);
    const shared = join(f.home, "git-objects", oid);
    expect(fs.statSync(shared).nlink).toBeGreaterThan(1);
    const object = join(sourcePath(f.home, current), ".git/objects", oid.slice(0, 2), oid.slice(2));
    expect(fs.statSync(object).ino).toBe(fs.statSync(shared).ino);
    expect(fs.readdirSync(join(f.home, "archives")).length).toBeGreaterThan(3);
    // Direct notes are retained and hold that source; no cleanup adopts them.
    fs.writeFileSync(join(sourcePath(f.home, current), "unknown-notes"), "keep");
    expect(() => execute(f.home, "sync", [])).toThrow(
      expect.objectContaining({ code: "SOURCE_DIRTY" }),
    );
    expect(fs.readFileSync(join(sourcePath(f.home, current), "unknown-notes"), "utf8")).toBe(
      "keep",
    );
  } finally {
    f.cleanup();
  }
});
test("explicit host metadata survives capture, updates and replacement outside skill hashes", () => {
  const f = fixture();
  try {
    const manifest = load(f.home).manifest;
    manifest.hostMetadata = ["workflow.md", "runs.json"];
    atomicJson(join(f.home, "skilltree.json"), manifest);
    install(f.home);
    const target = join(f.dest, "helper");
    fs.writeFileSync(join(target, "workflow.md"), "host workflow\n");
    fs.writeFileSync(join(target, "runs.json"), '{"runs":[1]}\n');
    expect(execute(f.home, "verify", [])).toMatchObject({ outcome: "CURRENT" });
    editBody(target, "First line", "Local first");
    execute(f.home, "capture", ["helper"]);
    editBody(f.skill, "Last line", "Upstream last");
    commit(f.repo, "update");
    execute(f.home, "sync", []);
    approveApply(f.home);
    expect(fs.readFileSync(join(target, "workflow.md"), "utf8")).toBe("host workflow\n");
    expect(fs.readFileSync(join(target, "runs.json"), "utf8")).toBe('{"runs":[1]}\n');
    expect(execute(f.home, "verify", [])).toMatchObject({ outcome: "CURRENT" });
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
    fs.writeFileSync(join(f.skill, "runs.json"), "upstream must not own host metadata");
    commit(f.repo, "reserved");
    expect(execute(f.home, "sync", [])).toMatchObject({
      result: {
        outcome: "PARTIAL",
        sources: [{ holds: [{ path: ".agents/skills/helper", code: "RESERVED_FILE" }] }],
        entries: [{ candidate: null, outcome: "HELD" }],
      },
    });
    expect(fs.readFileSync(join(target, "runs.json"), "utf8")).toContain('"runs"');
  } finally {
    f.cleanup();
  }
});
test("held results expose structured events without applying candidates", () => {
  const f = fixture();
  try {
    install(f.home);
    const deployed = load(f.home).lock.entries[0]!.deployed;
    editBody(f.skill, "Last line", "Requires review");
    commit(f.repo, "update");
    const result = execute(f.home, "sync", []) as { events: unknown[] };
    expect(result.events).toContainEqual(
      expect.objectContaining({ version: 1, type: "skill.held", id: "helper", source: "upstream" }),
    );
    expect(load(f.home).lock.entries[0]!.deployed).toEqual(deployed);
  } finally {
    f.cleanup();
  }
});
test("copied launcher exits nonzero with no prepared build", () => {
  const f = fixture();
  try {
    const launcher = join(f.root, "copy/bin/skilltree.mjs");
    fs.mkdirSync(join(f.root, "copy/bin"), { recursive: true });
    fs.copyFileSync(resolve("bin/skilltree.mjs"), launcher);
    const child = Bun.spawnSync([process.execPath, launcher, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain("build is missing");
  } finally {
    f.cleanup();
  }
});
test("standalone installer restores an excluded runner and holds digest/unknown-byte mismatches", () => {
  const f = fixture();
  try {
    const node = process.env.SKILLTREE_DEMO_NODE ?? Bun.which("node")!;
    const artifact = join(f.root, "approved.mjs");
    fs.writeFileSync(artifact, 'console.log("standalone fixture")\n');
    const sha = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
    const prefix = join(f.root, "installation");
    const installer = resolve("bin/install.mjs");
    const run = (args: string[]) =>
      Bun.spawnSync([node, installer, ...args], { stdout: "pipe", stderr: "pipe" });
    expect(
      run(["--prefix", prefix, "--artifact", artifact, "--sha256", sha, "--node", node]).exitCode,
    ).toBe(0);
    const launcher = join(prefix, "bin/skilltree");
    expect(
      Bun.spawnSync([launcher], { stdout: "pipe", stderr: "pipe" }).stdout.toString(),
    ).toContain("standalone fixture");
    fs.rmSync(join(prefix, "dist"), { recursive: true });
    expect(Bun.spawnSync([launcher], { stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);
    expect(run(["--prefix", prefix, "--restore"]).exitCode).toBe(0);
    expect(Bun.spawnSync([launcher], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    fs.writeFileSync(join(prefix, "dist", sha + ".mjs"), "unknown runner work");
    expect(run(["--prefix", prefix, "--restore"]).exitCode).toBe(1);
    expect(fs.readFileSync(join(prefix, "dist", sha + ".mjs"), "utf8")).toBe("unknown runner work");
    expect(
      run([
        "--prefix",
        join(f.root, "bad"),
        "--artifact",
        artifact,
        "--sha256",
        "0".repeat(64),
        "--node",
        node,
      ]).exitCode,
    ).toBe(1);
  } finally {
    f.cleanup();
  }
});
