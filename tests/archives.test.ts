import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { execute } from "../src/service";
import { load } from "../src/state";
import { sourcePath, localPath, git } from "../src/git";
import { fixture, install, editBody, authoritative } from "./helpers";
import { atomicJson } from "../src/files";

test("archives restore excluded source and local-history paths into fresh generations", () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.skill, "build"));
    fs.writeFileSync(join(f.skill, "build/guide"), "preserve tracked build");
    git(f.repo, ["add", "--all", "--force"]);
    git(f.repo, ["commit", "-m", "build content"]);
    execute(f.home, "sync", []);
    install(f.home);
    editBody(join(f.dest, "helper"), "First line", "Local improvement");
    execute(f.home, "capture", ["helper"]);
    const before = load(f.home);
    const source = before.lock.sources[0]!;
    const entry = before.lock.entries[0]!;
    const root = sourcePath(f.home, source);
    const history = localPath(f.home, "helper", entry.local);
    fs.rmSync(join(root, ".agents/skills/helper/build"), { recursive: true });
    fs.rmSync(join(history, "build"), { recursive: true });
    const pruned = authoritative(f.home);
    expect(execute(f.home, "restore", [], { dryRun: true })).toMatchObject({
      outcome: "WOULD_RESTORE",
    });
    expect(authoritative(f.home)).toBe(pruned);
    execute(f.home, "restore", []);
    const after = load(f.home);
    const restored = after.lock.entries[0]!;
    expect(restored.approval).toEqual(entry.approval);
    expect(restored.deployed).toEqual(entry.deployed);
    expect(restored.local!.commit).toBe(entry.local!.commit);
    expect(
      fs.readFileSync(
        join(sourcePath(f.home, after.lock.sources[0]!), ".agents/skills/helper/build/guide"),
        "utf8",
      ),
    ).toBe("preserve tracked build");
    expect(
      fs.readFileSync(join(localPath(f.home, "helper", restored.local), "build/guide"), "utf8"),
    ).toBe("preserve tracked build");
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(history)).toBe(true);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
    editBody(join(f.dest, "helper"), "Middle line", "More local");
    execute(f.home, "capture", ["helper"]);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});
for (const kind of ["source", "local"] as const)
  test(`restore retains unknown ${kind} work and holds`, () => {
    const f = fixture();
    try {
      install(f.home);
      editBody(join(f.dest, "helper"), "First line", "Local");
      execute(f.home, "capture", ["helper"]);
      const ctx = load(f.home);
      const root =
        kind === "source"
          ? sourcePath(f.home, ctx.lock.sources[0]!)
          : localPath(f.home, "helper", ctx.lock.entries[0]!.local);
      fs.writeFileSync(join(root, "unknown.txt"), "unsaved work");
      const before = authoritative(f.home);
      expect(() => execute(f.home, "restore", [])).toThrow(
        expect.objectContaining({ code: "RESTORE_HELD" }),
      );
      expect(authoritative(f.home)).toBe(before);
      expect(fs.readFileSync(join(root, "unknown.txt"), "utf8")).toBe("unsaved work");
    } finally {
      f.cleanup();
    }
  });
test("missing generated checkout restores offline, corrupt archive holds unchanged", () => {
  const f = fixture();
  try {
    const ctx = load(f.home);
    const source = ctx.lock.sources[0]!;
    fs.rmSync(sourcePath(f.home, source), { recursive: true });
    fs.renameSync(f.repo, f.repo + "-offline");
    execute(f.home, "restore", []);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
    const path = join(f.home, "archives", source.archive! + ".json");
    const value = JSON.parse(fs.readFileSync(path, "utf8"));
    value.revision = "0".repeat(40);
    atomicJson(path, value);
    const before = authoritative(f.home);
    expect(() => execute(f.home, "restore", [])).toThrow(
      expect.objectContaining({ code: "ARCHIVE_CORRUPT" }),
    );
    expect(authoritative(f.home)).toBe(before);
  } finally {
    f.cleanup();
  }
});
