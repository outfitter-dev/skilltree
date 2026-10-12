import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { git, sourcePath } from "../src/git";
import { execute } from "../src/service";
import { pending, load, withLock, runtimePath } from "../src/state";
import { paths, applyEntry, recover } from "../src/deployment";
import { atomicJson, liveHash } from "../src/files";
import {
  fixture,
  install,
  candidate,
  approveApply,
  editBody,
  body,
  commit,
  authoritative,
} from "./helpers";

test("requested install, shared profiles, repeat no-op, status and doctor", () => {
  const f = fixture();
  try {
    install(f.home);
    const before = liveHash(join(f.dest, "helper"))!;
    const entry = load(f.home).lock.entries[0]!;
    expect(entry.approval?.kind).toBe("user-install");
    expect(entry.deployed?.hash).toBe(before);
    expect(entry.upstream.hash).toBe(before);
    expect(fs.statSync(join(f.dest, "helper/scripts/run.sh")).mode & 0o111).not.toBe(0);
    execute(f.home, "assign", ["helper"], { profile: "writer" });
    expect(
      (execute(f.home, "list", [], { profile: "writer" }) as { entries: unknown[] }).entries,
    ).toHaveLength(1);
    expect(
      (execute(f.home, "list", [], { profile: "other" }) as { entries: unknown[] }).entries,
    ).toHaveLength(0);
    execute(f.home, "sync", []);
    execute(f.home, "apply", ["helper"], { hash: candidate(f.home) });
    expect(liveHash(join(f.dest, "helper"))).toBe(before);
    expect((execute(f.home, "doctor", []) as { outcome: string }).outcome).toBe("OK");
    expect((execute(f.home, "verify", []) as { outcome: string }).outcome).toBe("CURRENT");
  } finally {
    f.cleanup();
  }
});
test("live drift is held; captured local patch survives upstream update", () => {
  const f = fixture();
  try {
    install(f.home);
    const target = join(f.dest, "helper");
    editBody(target, "First line", "Local first");
    const changed = liveHash(target)!;
    editBody(f.skill, "Last line", "Upstream last");
    commit(f.repo, "upstream change");
    execute(f.home, "sync", []);
    expect(load(f.home).lock.entries[0]!.outcome).toBe("DRIFT");
    expect(liveHash(target)).toBe(changed);
    expect((execute(f.home, "verify", []) as { outcome: string }).outcome).toBe("DRIFT");
    execute(f.home, "capture", ["helper"]);
    execute(f.home, "sync", []);
    const staged = load(f.home).lock.entries[0]!;
    expect(staged.local?.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(staged.deployed?.hash).not.toBe(changed);
    expect(staged.observed).toBe(changed);
    expect(staged.candidate?.hash).not.toBe(staged.upstream.hash);
    expect(() => execute(f.home, "apply", ["helper"], { hash: candidate(f.home) })).toThrow(
      "Approve the exact",
    );
    approveApply(f.home);
    expect(body(target)).toContain("Local first");
    expect(body(target)).toContain("Upstream last");
    const after = liveHash(target)!;
    execute(f.home, "sync", []);
    expect(candidate(f.home)).toBe(after);
    expect((execute(f.home, "verify", []) as { outcome: string }).outcome).toBe("CURRENT");
  } finally {
    f.cleanup();
  }
});
test("conflicting update leaves deployed bytes and local history intact", () => {
  const f = fixture();
  try {
    install(f.home);
    const target = join(f.dest, "helper");
    editBody(target, "First line", "Local conflict");
    execute(f.home, "capture", ["helper"]);
    const before = liveHash(target);
    const accepted = load(f.home).lock.entries[0]!;
    const local = accepted.local;
    editBody(f.skill, "First line", "Upstream conflict");
    commit(f.repo, "conflict");
    execute(f.home, "sync", []);
    const entry = load(f.home).lock.entries[0]!;
    expect(entry.outcome).toBe("CONFLICT");
    expect(entry.candidate).toBeNull();
    expect(entry.local).toEqual(local);
    expect(entry.upstream).toEqual(accepted.upstream);
    expect(entry.approval).toEqual(accepted.approval);
    expect(entry.deployed).toEqual(accepted.deployed);
    expect(load(f.home).lock.sources[0]!.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(liveHash(target)).toBe(before);
  } finally {
    f.cleanup();
  }
});
test("supporting script changes invalidate approval; stale approval cannot apply", () => {
  const f = fixture();
  try {
    install(f.home);
    const old = candidate(f.home);
    fs.appendFileSync(join(f.skill, "scripts/run.sh"), "echo new-script\n");
    commit(f.repo, "script update");
    execute(f.home, "sync", []);
    expect(candidate(f.home)).not.toBe(old);
    expect(load(f.home).lock.entries[0]!.reasons.join(" ")).toContain("support script");
    expect(() => execute(f.home, "approve", ["helper"], { hash: old, reason: "old" })).toThrow(
      "current complete",
    );
    expect(() => execute(f.home, "apply", ["helper"], { hash: old })).toThrow("current staged");
    expect(() => execute(f.home, "apply", ["helper"], { hash: candidate(f.home) })).toThrow(
      "Approve the exact",
    );
    approveApply(f.home);
    expect(fs.readFileSync(join(f.dest, "helper/scripts/run.sh"), "utf8")).toContain("new-script");
  } finally {
    f.cleanup();
  }
});
test("unknown folder collisions and upstream skill removals are preserved", () => {
  const f = fixture();
  try {
    const target = join(f.dest, "helper");
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, "SKILL.md"), "owner's existing content");
    expect(() => install(f.home)).toThrow("not owned");
    expect(fs.readFileSync(join(target, "SKILL.md"), "utf8")).toBe("owner's existing content");
    fs.rmSync(target, { recursive: true });
    install(f.home);
    const deployed = liveHash(target);
    fs.renameSync(f.skill, join(f.repo, "renamed"));
    commit(f.repo, "rename skill");
    execute(f.home, "sync", []);
    expect(load(f.home).lock.entries[0]!.outcome).toBe("HELD");
    expect(liveHash(target)).toBe(deployed);
  } finally {
    f.cleanup();
  }
});
test("dry runs do not change authoritative state or destination", () => {
  const f = fixture();
  try {
    install(f.home);
    const before = authoritative(f.home);
    const live = liveHash(join(f.dest, "helper"));
    execute(f.home, "sync", [], { dryRun: true });
    execute(f.home, "approve", ["helper"], {
      hash: candidate(f.home),
      reason: "dry",
      dryRun: true,
    });
    execute(f.home, "assign", ["helper"], { profile: "new", dryRun: true });
    execute(f.home, "apply", ["helper"], { hash: candidate(f.home), dryRun: true });
    execute(f.home, "capture", ["helper"], { dryRun: true });
    execute(f.home, "recover", [], { dryRun: true });
    expect(authoritative(f.home)).toBe(before);
    expect(liveHash(join(f.dest, "helper"))).toBe(live);
  } finally {
    f.cleanup();
  }
});
test("concurrent runs return LOCKED and cannot steal a live lock", () => {
  const f = fixture();
  try {
    withLock(load(f.home), () => {
      expect(() => execute(f.home, "sync", [])).toThrow("Another run");
      expect(() => execute(f.home, "recover", [], { unlock: true })).toThrow("still alive");
    });
    expect((execute(f.home, "doctor", []) as { outcome: string }).outcome).toBe("OK");
  } finally {
    f.cleanup();
  }
});
test("interrupted nonempty replacement restores last directory on restart", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(f.skill, "Last line", "New last");
    commit(f.repo, "new");
    execute(f.home, "sync", []);
    execute(f.home, "approve", ["helper"], { hash: candidate(f.home), reason: "reviewed" });
    const ctx = load(f.home);
    const before = ctx.lock.entries[0]!.deployed!.hash;
    expect(() =>
      withLock(ctx, () =>
        applyEntry(ctx, ctx.lock.entries[0]!, candidate(f.home), false, () => {
          throw new Error("simulated interruption");
        }),
      ),
    ).toThrow("interruption");
    expect(liveHash(join(f.dest, "helper"))).toBeNull();
    expect(() => execute(f.home, "sync", [])).toThrow("Interrupted replacement");
    expect((execute(f.home, "recover", []) as { result: { outcome: string } }).result.outcome).toBe(
      "RECOVERED",
    );
    expect(liveHash(join(f.dest, "helper"))).toBe(before);
    approveApply(f.home);
    expect(body(join(f.dest, "helper"))).toContain("New last");
  } finally {
    f.cleanup();
  }
});
test("host writes during replacement are retained and recovered", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(f.skill, "Last line", "New last");
    commit(f.repo, "new");
    execute(f.home, "sync", []);
    execute(f.home, "approve", ["helper"], { hash: candidate(f.home), reason: "reviewed" });
    const ctx = load(f.home);
    expect(() =>
      withLock(ctx, () =>
        applyEntry(ctx, ctx.lock.entries[0]!, candidate(f.home), false, () => {
          const journal = pending(ctx)!;
          editBody(paths(ctx, journal.transaction).backup, "First line", "Host write");
        }),
      ),
    ).toThrow("Concurrent write");
    execute(f.home, "recover", []);
    expect(body(join(f.dest, "helper"))).toContain("Host write");
    expect((execute(f.home, "verify", []) as { outcome: string }).outcome).toBe("DRIFT");
  } finally {
    f.cleanup();
  }
});
test("recovery completes an already replaced directory and refuses unknown bytes", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home);
    const entry = ctx.lock.entries[0]!;
    const transaction = "4e800ae6-51ad-4bfe-8747-624e50289601";
    atomicJson(join(f.home, "transaction.json"), {
      version: 1,
      transaction,
      id: "helper",
      oldHash: null,
      next: entry,
    });
    expect((recover(ctx, true) as { outcome: string }).outcome).toBe("WOULD_COMPLETE");
    expect(fs.existsSync(join(f.home, "transaction.json"))).toBe(true);
    recover(ctx, false);
    atomicJson(join(f.home, "transaction.json"), {
      version: 1,
      transaction,
      id: "helper",
      oldHash: null,
      next: entry,
    });
    editBody(join(f.dest, "helper"), "First line", "Unknown writer");
    expect(() => recover(load(f.home), false)).toThrow("unknown destination");
    expect(body(join(f.dest, "helper"))).toContain("Unknown writer");
  } finally {
    f.cleanup();
  }
});
test("explicit stale lock recovery does not change approvals", () => {
  const f = fixture();
  try {
    const runtime = runtimePath(
      f.dest,
      load(f.home).manifest.runtimeRoot,
      load(f.home).manifest.runtimeVersion,
    );
    fs.mkdirSync(join(runtime, "lock"), { recursive: true });
    atomicJson(join(runtime, "lock/owner.json"), { pid: 2147483647 });
    const before = authoritative(f.home);
    execute(f.home, "recover", [], { unlock: true, dryRun: true });
    expect(fs.existsSync(join(runtime, "lock"))).toBe(true);
    execute(f.home, "recover", [], { unlock: true });
    expect(fs.existsSync(join(runtime, "lock"))).toBe(false);
    expect(load(f.home).lock.entries).toHaveLength(0);
    expect(before).toContain("skilltree.lock");
  } finally {
    f.cleanup();
  }
});

test("read-only diagnostics leave state and runtime lock untouched", () => {
  const f = fixture();
  try {
    install(f.home);
    const before = authoritative(f.home);
    for (const command of ["status", "list", "verify", "doctor", "inventory"]) {
      execute(f.home, command, command === "inventory" ? ["upstream"] : []);
    }
    expect(authoritative(f.home)).toBe(before);
    expect(
      fs.existsSync(
        join(
          runtimePath(
            f.dest,
            load(f.home).manifest.runtimeRoot,
            load(f.home).manifest.runtimeVersion,
          ),
          "lock",
        ),
      ),
    ).toBe(false);
  } finally {
    f.cleanup();
  }
});
test("init/add/select dry runs create no ownership or approval records", () => {
  const f = fixture();
  try {
    const empty = join(f.root, "preview-state"),
      dest = join(f.root, "preview-library");
    execute(empty, "init", [], { destination: dest, exclusive: true, dryRun: true });
    expect(fs.existsSync(empty)).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
    const before = authoritative(f.home);
    execute(f.home, "add", [f.repo], { source: "preview", ref: "main", dryRun: true });
    execute(f.home, "select", ["upstream"], {
      path: ".agents/skills/helper",
      id: "helper",
      install: true,
      reason: "Preview request",
      dryRun: true,
    });
    expect(authoritative(f.home)).toBe(before);
    expect(fs.readdirSync(f.dest)).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test("post-approval source changes create a new held candidate", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(f.skill, "Last line", "Version two");
    commit(f.repo, "two");
    execute(f.home, "sync", []);
    const reviewed = candidate(f.home);
    execute(f.home, "approve", ["helper"], { hash: reviewed, reason: "reviewed two" });
    editBody(f.skill, "Last line", "Version three");
    fs.appendFileSync(join(f.skill, "SKILL.md"), "Third revision\n");
    commit(f.repo, "three");
    execute(f.home, "sync", []);
    expect(candidate(f.home)).not.toBe(reviewed);
    expect(() => execute(f.home, "apply", ["helper"], { hash: reviewed })).toThrow(
      "current staged",
    );
    expect(() => execute(f.home, "apply", ["helper"], { hash: candidate(f.home) })).toThrow(
      "Approve the exact",
    );
    expect(body(join(f.dest, "helper"))).not.toContain("Third revision");
  } finally {
    f.cleanup();
  }
});
test("binary merge conflicts preserve deployed bytes", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.skill, "data.bin"), Buffer.from([0, 1, 2]));
    commit(f.repo, "binary base");
    execute(f.home, "sync", []);
    install(f.home);
    fs.writeFileSync(join(f.dest, "helper/data.bin"), Buffer.from([0, 1, 3]));
    execute(f.home, "capture", ["helper"]);
    fs.writeFileSync(join(f.skill, "data.bin"), Buffer.from([0, 1, 4]));
    commit(f.repo, "binary upstream");
    execute(f.home, "sync", []);
    expect(load(f.home).lock.entries[0]!.outcome).toBe("CONFLICT");
    expect(fs.readFileSync(join(f.dest, "helper/data.bin"))).toEqual(Buffer.from([0, 1, 3]));
  } finally {
    f.cleanup();
  }
});
test("dirty local history is preserved rather than cleared", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(join(f.dest, "helper"), "First line", "Local");
    execute(f.home, "capture", ["helper"]);
    const history = join(f.home, "edits/helper/SKILL.md");
    fs.appendFileSync(history, "Uncommitted work\n");
    expect(() => execute(f.home, "capture", ["helper"])).toThrow("reconcile edits");
    expect(fs.readFileSync(history, "utf8")).toContain("Uncommitted work");
  } finally {
    f.cleanup();
  }
});

test("clean supporting-file renames and deletions require new approval", () => {
  const f = fixture();
  try {
    install(f.home);
    fs.renameSync(join(f.skill, "scripts/run.sh"), join(f.skill, "scripts/new.sh"));
    commit(f.repo, "rename support");
    execute(f.home, "sync", []);
    approveApply(f.home);
    expect(fs.existsSync(join(f.dest, "helper/scripts/run.sh"))).toBe(false);
    expect(fs.readFileSync(join(f.dest, "helper/scripts/new.sh"), "utf8")).toContain("original");
    fs.unlinkSync(join(f.skill, "scripts/new.sh"));
    commit(f.repo, "delete support");
    execute(f.home, "sync", []);
    approveApply(f.home);
    expect(fs.existsSync(join(f.dest, "helper/scripts/new.sh"))).toBe(false);
  } finally {
    f.cleanup();
  }
});
test("modified acquired sources are preserved and cannot be mislabeled upstream", () => {
  const f = fixture();
  try {
    const changed = join(
      sourcePath(f.home, load(f.home).lock.sources[0]!),
      ".agents/skills/helper/SKILL.md",
    );
    fs.appendFileSync(changed, "Uncommitted source work\n");
    expect(() => install(f.home)).toThrow(expect.objectContaining({ code: "SOURCE_DIRTY" }));
    expect(() => execute(f.home, "sync", [])).toThrow(
      expect.objectContaining({ code: "SOURCE_DIRTY" }),
    );
    expect(fs.readFileSync(changed, "utf8")).toContain("Uncommitted source work");
  } finally {
    f.cleanup();
  }
});

test("capture cannot approve an unreconciled local snapshot", () => {
  const f = fixture();
  try {
    install(f.home);
    const previous = candidate(f.home);
    editBody(join(f.dest, "helper"), "First line", "Captured local");
    execute(f.home, "capture", ["helper"]);
    expect(load(f.home).lock.entries[0]!.candidate).toBeNull();
    expect(() =>
      execute(f.home, "approve", ["helper"], { hash: previous, reason: "stale" }),
    ).toThrow("current complete");
    execute(f.home, "sync", []);
    expect(candidate(f.home)).not.toBe(previous);
  } finally {
    f.cleanup();
  }
});

test("process exit during replacement leaves a stale lock and recovers through a fresh CLI", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(f.skill, "Last line", "Crash-test update");
    commit(f.repo, "crash-test upstream");
    execute(f.home, "sync", []);
    const digest = candidate(f.home);
    execute(f.home, "approve", ["helper"], { hash: digest, reason: "reviewed crash test" });
    const before = load(f.home).lock.entries[0]!.deployed!.hash;
    const code = `import {load,withLock} from './src/state.ts'; import {applyEntry} from './src/deployment.ts'; const ctx=load(process.argv[1]); withLock(ctx,()=>applyEntry(ctx,ctx.lock.entries[0],process.argv[2],false,()=>process.exit(17)));`;
    const crash = Bun.spawnSync([process.execPath, "-e", code, f.home, digest], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(crash.exitCode).toBe(17);
    expect(
      fs.existsSync(
        join(
          runtimePath(
            f.dest,
            load(f.home).manifest.runtimeRoot,
            load(f.home).manifest.runtimeVersion,
          ),
          "lock",
        ),
      ),
    ).toBe(true);
    expect(liveHash(join(f.dest, "helper"))).toBeNull();
    const restarted = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "recover", "--home", f.home, "--unlock"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(restarted.exitCode).toBe(0);
    expect(JSON.parse(restarted.stdout.toString()).result.outcome).toBe("RECOVERED");
    expect(
      fs.existsSync(
        join(
          runtimePath(
            f.dest,
            load(f.home).manifest.runtimeRoot,
            load(f.home).manifest.runtimeVersion,
          ),
          "lock",
        ),
      ),
    ).toBe(false);
    expect(liveHash(join(f.dest, "helper"))).toBe(before);
  } finally {
    f.cleanup();
  }
});
