import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { fixture } from "./helpers";
import { readTree, treeHash, putObject, getObject } from "../src/files";
import { discover } from "../src/discovery";
import { mergeTrees } from "../src/git";

test("whole-tree hash includes support bytes, names, and executable bits", () => {
  const f = fixture();
  try {
    const initial = treeHash(readTree(f.skill));
    const script = join(f.skill, "scripts/run.sh");
    fs.chmodSync(script, 0o644);
    expect(treeHash(readTree(f.skill))).not.toBe(initial);
    fs.chmodSync(script, 0o755);
    expect(treeHash(readTree(f.skill))).toBe(initial);
    fs.appendFileSync(script, "echo changed\n");
    expect(treeHash(readTree(f.skill))).not.toBe(initial);
    fs.renameSync(script, join(f.skill, "scripts/renamed.sh"));
    expect(treeHash(readTree(f.skill))).not.toBe(initial);
  } finally {
    f.cleanup();
  }
});
test("unsafe, legacy and run-log files are rejected", () => {
  const f = fixture();
  try {
    fs.symlinkSync("/etc/passwd", join(f.skill, "outside"));
    expect(() => readTree(f.skill)).toThrow("Symlink");
    fs.unlinkSync(join(f.skill, "outside"));
    for (const name of ["runs.json", "workflow.md"]) {
      fs.writeFileSync(join(f.skill, name), "unsafe");
      expect(() => readTree(f.skill)).toThrow("reserved");
      fs.unlinkSync(join(f.skill, name));
    }
  } finally {
    f.cleanup();
  }
});
test("content objects are checked on read", () => {
  const f = fixture();
  try {
    const digest = putObject(f.home, readTree(f.skill));
    const object = join(f.home, "objects", `${digest}.json`);
    const value = JSON.parse(fs.readFileSync(object, "utf8"));
    value["SKILL.md"].data = Buffer.from("tampered").toString("base64");
    fs.writeFileSync(object, JSON.stringify(value));
    expect(() => getObject(f.home, digest)).toThrow("does not match");
  } finally {
    f.cleanup();
  }
});
test("duplicate projections are preserved and marked equivalent or ambiguous", () => {
  const f = fixture();
  try {
    const duplicate = join(f.repo, "skills/other");
    fs.cpSync(f.skill, duplicate, { recursive: true });
    let items = discover(f.repo);
    expect(items).toHaveLength(2);
    expect(items[0]!.equivalentPaths).toHaveLength(1);
    expect(items[0]!.ambiguous).toBe(false);
    fs.appendFileSync(join(duplicate, "SKILL.md"), "Different\n");
    items = discover(f.repo);
    expect(items[0]!.ambiguous).toBe(true);
    expect(items[0]!.equivalentPaths).toHaveLength(0);
    fs.mkdirSync(join(f.repo, ".cursor-plugin"));
    fs.writeFileSync(join(f.repo, ".cursor-plugin/plugin.json"), "{}");
    expect(() => discover(f.repo)).toThrow("requires an adapter");
  } finally {
    f.cleanup();
  }
});
test("local Claude plugin declarations include support files and reject escape paths", () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.repo, ".claude-plugin"));
    fs.cpSync(f.skill, join(f.repo, "custom/helper"), { recursive: true });
    const manifest = join(f.repo, ".claude-plugin/plugin.json");
    fs.writeFileSync(manifest, JSON.stringify({ skills: ["./custom/helper"] }));
    expect(discover(f.repo).find((s) => s.path === "custom/helper")?.format).toBe("claude-plugin");
    fs.writeFileSync(manifest, JSON.stringify({ skills: ["./../outside"] }));
    expect(() => discover(f.repo)).toThrow();
  } finally {
    f.cleanup();
  }
});
test("three-way file deletes preserve competing local changes", () => {
  const f = fixture();
  try {
    const base = readTree(f.skill);
    const local = structuredClone(base);
    local["scripts/run.sh"]!.data = Buffer.from("local").toString("base64");
    const upstream = structuredClone(base);
    delete upstream["scripts/run.sh"];
    const conflict = mergeTrees(base, local, upstream, f.root);
    expect(conflict.tree).toBeNull();
    expect(conflict.conflicts).toEqual(["scripts/run.sh"]);
    const clean = mergeTrees(base, base, upstream, f.root);
    expect(clean.tree?.["scripts/run.sh"]).toBeUndefined();
  } finally {
    f.cleanup();
  }
});

test("external dependencies and missing/outside support references fail clearly", () => {
  const f = fixture();
  try {
    const file = join(f.skill, "SKILL.md");
    const initial = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      initial.replace(
        "description: Fixture helper",
        "description: Fixture helper\ndependencies: [external]",
      ),
    );
    expect(() => discover(f.repo)).toThrow("dependency");
    fs.writeFileSync(file, initial + "\n[missing](../outside.md)\n");
    expect(() => discover(f.repo)).toThrow("complete skill file set");
    fs.writeFileSync(file, initial + "\n[script](scripts/run.sh)\n");
    expect(discover(f.repo)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
