import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { chooseSkills, selectedIds, sourceId } from "../src/source-selection";
import { discover } from "../src/discovery";
import { execute } from "../src/service";
import { load } from "../src/state";
import { git } from "../src/git";
import { fixture, authoritative, commit, install } from "./helpers";

test("qualified repository identities retain owner/repo boundaries despite slug collisions", () => {
  const f = fixture();
  try {
    install(f.home);
    expect(sourceId("a-b/c")).toBe(sourceId("a/b-c"));
    const entry = load(f.home).lock.entries[0]!;
    const source = { ...load(f.home).lock.sources[0]!, repository: "https://github.com/a/b-c.git" };
    expect(() => selectedIds([entry], [source], ["a-b/c@helper"])).toThrow("Unknown selection");
    expect([...selectedIds([entry], [source], ["A/B-C@helper"])]).toEqual(["helper"]);
    expect(() => chooseSkills(discover(f.repo), ["a-b/c@helper"], source.repository)).toThrow(
      "different repository",
    );
    expect(chooseSkills(discover(f.repo), ["a/b-c@helper"], source.repository)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test("add refreshes an existing registration without changing untouched selections or dry-run state", () => {
  const f = fixture();
  try {
    install(f.home);
    const original = load(f.home).lock.entries[0]!;
    fs.mkdirSync(join(f.repo, "skills/new-skill"), { recursive: true });
    fs.writeFileSync(
      join(f.repo, "skills/new-skill/SKILL.md"),
      "---\nname: new-skill\ndescription: New fixture\n---\nNew content\n",
    );
    commit(f.repo, "new upstream selection");
    const before = authoritative(f.home);
    const listing = execute(f.home, "add", [f.repo], { list: true }) as {
      skills: { name: string }[];
    };
    expect(listing.skills.map((s) => s.name)).toContain("new-skill");
    expect(authoritative(f.home)).toBe(before);
    expect(execute(f.home, "add", [f.repo], { skills: ["new-skill"], dryRun: true })).toMatchObject(
      { outcome: "WOULD_SELECT", entries: [{ name: "new-skill" }] },
    );
    expect(authoritative(f.home)).toBe(before);
    execute(f.home, "add", [f.repo], { skills: ["new-skill"] });
    const current = load(f.home).lock;
    expect(current.sources[0]!.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(current.entries.find((e) => e.id === "helper")).toEqual(original);
    expect(current.entries.find((e) => e.id === "new-skill")!.outcome).toBe("HELD");
    expect(fs.existsSync(join(f.dest, "new-skill"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

test("every positional removal operand rejects a source/skill ambiguity before staging", () => {
  const f = fixture();
  try {
    execute(f.home, "select", ["upstream"], { path: ".agents/skills/helper", id: "upstream" });
    const before = authoritative(f.home);
    for (const args of [["upstream"], ["upstream", "other"], ["other", "upstream"]]) {
      expect(() => execute(f.home, "remove", args)).toThrow("Name matches a source and a skill");
      expect(authoritative(f.home)).toBe(before);
    }
    expect(load(f.home).lock.entries[0]!.removal).toBeUndefined();
  } finally {
    f.cleanup();
  }
});

test("restore preview refuses reused source identities without mutating state or the library", () => {
  const f = fixture();
  try {
    const point = (execute(f.home, "backup", []) as { result: { snapshot: string } }).result;
    execute(f.home, "remove", [], { source: "upstream" });
    const second = join(f.root, "different-repository");
    git(f.root, ["clone", "--no-local", f.repo, second]);
    execute(f.home, "add", [second], { source: "upstream" });
    const before = authoritative(f.home);
    expect(() => execute(f.home, "revert", [], { snapshot: point.snapshot, dryRun: true })).toThrow(
      "reused for another repository",
    );
    expect(authoritative(f.home)).toBe(before);
    expect(fs.readdirSync(f.dest)).toEqual([]);
  } finally {
    f.cleanup();
  }
});
