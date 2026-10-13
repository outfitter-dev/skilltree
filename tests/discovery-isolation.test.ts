import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discover } from "../src/discovery";
import { execute } from "../src/service";
import { load, save } from "../src/state";
import { git, sourcePath } from "../src/git";
import { readTree, treeHash } from "../src/files";
import { authoritative, commit, editBody, fixture, install } from "./helpers";

function skill(repo: string, path: string, name: string, body = "Fixture\n") {
  const root = join(repo, path);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture\n---\n${body}`,
  );
  return root;
}

test("reference, metadata, unsupported-format and unsafe projections hold independently", () => {
  const f = fixture();
  try {
    skill(f.repo, "skills/placeholder", "placeholder", "[Title](URL)\n");
    const broken = skill(f.repo, "skills/broken", "broken");
    fs.writeFileSync(join(broken, "AGENTS.md"), "[guide](references/absent.md)\n");
    skill(f.repo, "skills/escape", "escape", "[outside](../outside.md)\n");
    skill(f.repo, "skills/encoded", "encoded", "[bad](%FF.md)\n");
    skill(f.repo, "skills/invalid", "invalid");
    fs.writeFileSync(join(f.repo, "skills/invalid/SKILL.md"), "---\nname: []\n---\n");
    fs.symlinkSync("../../outside", join(f.repo, "skills/linked"));
    fs.symlinkSync("/etc/passwd", join(broken, "support-link"));
    for (const format of ["cursor", "codex", "chatgpt"]) {
      fs.mkdirSync(join(f.repo, `.${format}-plugin`));
      // Invalid JSON must never be interpreted through an unsupported adapter.
      fs.writeFileSync(join(f.repo, `.${format}-plugin/plugin.json`), "not JSON");
    }
    const result = discover(f.repo);
    expect(result.skills.map((s) => s.path)).toEqual([".agents/skills/helper"]);
    for (const [path, code] of [
      ["skills/placeholder", "MISSING_REFERENCE"],
      ["skills/escape", "MISSING_REFERENCE"],
      ["skills/encoded", "INVALID_REFERENCE"],
      ["skills/invalid", "INVALID_SKILL"],
      ["skills/linked", "UNSAFE_TREE"],
      ["skills/broken", "UNSAFE_TREE"],
      [".cursor-plugin/plugin.json", "UNSUPPORTED_FORMAT"],
      [".codex-plugin/plugin.json", "UNSUPPORTED_FORMAT"],
      [".chatgpt-plugin/plugin.json", "UNSUPPORTED_FORMAT"],
    ])
      expect(result.holds).toContainEqual(expect.objectContaining({ path, code }));
    fs.unlinkSync(join(broken, "support-link"));
    expect(discover(f.repo).holds).toContainEqual(
      expect.objectContaining({
        path: "skills/broken",
        code: "MISSING_REFERENCE",
        message: expect.stringContaining("AGENTS.md"),
      }),
    );
    commit(f.repo, "mixed projections");
    execute(f.home, "sync", []);
    const before = authoritative(f.home);
    expect(
      execute(f.home, "select", ["upstream"], {
        path: ".agents/skills/helper",
        id: "healthy",
        dryRun: true,
      }),
    ).toMatchObject({
      outcome: "WOULD_SELECT",
      events: [{ type: "skill.held", path: ".agents/skills/helper" }],
    });
    expect(() =>
      execute(f.home, "select", ["upstream"], {
        path: "skills/placeholder",
        id: "bad",
        dryRun: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "MISSING_REFERENCE",
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "skill.held",
            path: "skills/placeholder",
            code: "MISSING_REFERENCE",
          }),
        ]),
      }),
    );
    expect(authoritative(f.home)).toBe(before);
    install(f.home);
    expect(execute(f.home, "verify", [])).toMatchObject({ outcome: "CURRENT" });
  } finally {
    f.cleanup();
  }
});

test("invalid selected skill retains local edits and approvals while a healthy peer stages", () => {
  const f = fixture();
  try {
    skill(f.repo, "skills/peer", "peer");
    commit(f.repo, "peer");
    execute(f.home, "sync", []);
    install(f.home);
    execute(f.home, "select", ["upstream"], {
      path: "skills/peer",
      id: "peer",
      install: true,
      reason: "Explicit fixture request",
    });
    editBody(join(f.dest, "helper"), "First line", "Local first");
    execute(f.home, "capture", ["helper"]);
    const accepted = load(f.home).lock;
    const old = accepted.entries[0]!;
    const library = treeHash(readTree(join(f.dest, "helper")));
    fs.writeFileSync(join(f.skill, "AGENTS.md"), "[missing](references/absent.md)\n");
    fs.appendFileSync(join(f.repo, "skills/peer/SKILL.md"), "New peer\n");
    commit(f.repo, "invalid one and update peer");
    const before = authoritative(f.home);
    const dry = execute(f.home, "sync", [], { dryRun: true });
    expect(dry).toMatchObject({
      outcome: "PARTIAL",
      dryRun: true,
      entries: [
        { id: "helper", candidate: null, outcome: "HELD" },
        { id: "peer", candidate: { revision: git(f.repo, ["rev-parse", "HEAD"]) } },
      ],
    });
    expect(authoritative(f.home)).toBe(before);
    const real = execute(f.home, "sync", []) as { result: unknown };
    expect(real.result).toMatchObject({ outcome: "PARTIAL", dryRun: false });
    const next = load(f.home).lock;
    expect(next.entries[0]).toEqual({
      ...old,
      candidate: null,
      outcome: "HELD",
      reasons: [expect.stringContaining(".agents/skills/helper")],
    });
    expect(next.sources[0]!.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(git(sourcePath(f.home, accepted.sources[0]!), ["rev-parse", "HEAD"])).toBe(
      accepted.sources[0]!.revision,
    );
    expect(treeHash(readTree(join(f.dest, "helper")))).toBe(library);
    expect(() =>
      execute(f.home, "approve", ["helper"], {
        hash: old.approval!.hash,
        reason: "stale approval",
      }),
    ).toThrow(expect.objectContaining({ code: "STALE_CANDIDATE" }));
    fs.unlinkSync(join(f.skill, "AGENTS.md"));
    editBody(f.skill, "Last line", "New upstream last");
    commit(f.repo, "repair selected skill");
    execute(f.home, "sync", []);
    const current = load(f.home).lock.entries[0]!;
    expect(current.candidate).not.toBeNull();
    expect(current.local).toEqual(old.local);
    expect(current.approval).toEqual(old.approval);
    expect(current.deployed).toEqual(old.deployed);
  } finally {
    f.cleanup();
  }
});

test("plugin traversal holds its declaration and healthy declarations remain usable", () => {
  const f = fixture();
  try {
    skill(f.repo, "custom/healthy", "custom");
    fs.mkdirSync(join(f.repo, ".claude-plugin"));
    fs.writeFileSync(
      join(f.repo, ".claude-plugin/plugin.json"),
      JSON.stringify({ skills: ["./../outside", "./custom/healthy"] }),
    );
    const inventory = discover(f.repo);
    expect(inventory.skills.map((s) => s.path)).toContain("custom/healthy");
    expect(inventory.holds).toContainEqual(
      expect.objectContaining({ path: ".claude-plugin/plugin.json", code: "INVALID_PLUGIN" }),
    );
    fs.writeFileSync(join(f.repo, ".claude-plugin/plugin.json"), "{");
    expect(discover(f.repo).skills.map((s) => s.path)).toEqual([".agents/skills/helper"]);
    fs.writeFileSync(join(f.repo, ".claude-plugin/marketplace.json"), "{}");
    expect(discover(f.repo).holds).toContainEqual(
      expect.objectContaining({
        path: ".claude-plugin/marketplace.json",
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  } finally {
    f.cleanup();
  }
});

test("plugin rescan does not duplicate failed-skill or symlink holds", () => {
  const f = fixture();
  try {
    const broken = skill(f.repo, "skills/broken", "broken");
    fs.writeFileSync(join(broken, "AGENTS.md"), "[guide](references/absent.md)\n");
    fs.symlinkSync("../../outside", join(f.repo, "skills/linked"));
    skill(f.repo, "skills/healthy", "healthy");
    skill(f.repo, "custom/extra", "extra");
    fs.mkdirSync(join(f.repo, ".claude-plugin"));
    const manifest = join(f.repo, ".claude-plugin/plugin.json");
    fs.writeFileSync(manifest, "{}\n");
    const omitted = discover(f.repo);
    expect(omitted.skills.map((item) => item.path)).toEqual([
      ".agents/skills/helper",
      "skills/healthy",
    ]);
    expect(omitted.skills.find((item) => item.path === "skills/healthy")?.format).toBe("plain");
    expect(omitted.holds.filter((hold) => hold.path === "skills/broken")).toEqual([
      expect.objectContaining({ scope: "skill", code: "MISSING_REFERENCE" }),
    ]);
    expect(omitted.holds.filter((hold) => hold.path === "skills/linked")).toEqual([
      expect.objectContaining({
        scope: "projection",
        code: "UNSAFE_TREE",
        message: "Symlink in skill discovery tree",
      }),
    ]);
    fs.writeFileSync(
      manifest,
      JSON.stringify({ skills: ["./skills", "./skills", "./custom/extra"] }),
    );
    const declared = discover(f.repo);
    expect(declared.holds.filter((hold) => hold.path === "skills/broken")).toHaveLength(1);
    expect(declared.holds.filter((hold) => hold.path === "skills/linked")).toHaveLength(1);
    expect(declared.skills.find((item) => item.path === "custom/extra")?.format).toBe(
      "claude-plugin",
    );
  } finally {
    f.cleanup();
  }
});

test("supported large files validate in V8 and actual size limits identify only the affected skill", async () => {
  const f = fixture();
  try {
    const built = await Bun.build({
      entrypoints: [join(process.cwd(), "src/model.ts")],
      outdir: join(f.root, "schema"),
      naming: "model.mjs",
      target: "node",
    });
    expect(built.success).toBe(true);
    const url = pathToFileURL(join(f.root, "schema/model.mjs")).href;
    const code = `import {fileSchema} from ${JSON.stringify(url)};
      for (const size of [5_000_000, 10_000_000]) fileSchema.parse({data:Buffer.alloc(size).toString('base64'),executable:false});
      for (const data of ['', 'YQ==', 'YWI=', 'YWJj']) if(!fileSchema.safeParse({data,executable:false}).success) throw Error('valid base64 rejected');
      for (const data of ['YQ=', 'Y===', '====', 'YWJ!', 'YW=J', 'YQ==\\n']) if(fileSchema.safeParse({data,executable:false}).success) throw Error('invalid base64 accepted');`;
    const child = Bun.spawnSync(["node", "--input-type=module", "-e", code], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    fs.writeFileSync(join(f.skill, "data.bin"), Buffer.alloc(5_000_000));
    expect(discover(f.repo).skills).toHaveLength(1);
    fs.writeFileSync(join(f.skill, "data.bin"), Buffer.alloc(10_000_001));
    skill(f.repo, "skills/healthy", "healthy");
    const inventory = discover(f.repo);
    expect(inventory.skills.map((s) => s.path)).toEqual(["skills/healthy"]);
    expect(inventory.holds).toEqual([
      {
        path: ".agents/skills/helper",
        scope: "skill",
        code: "TREE_LIMIT",
        message: "Skill file exceeds 10,000,000 bytes: data.bin",
      },
    ]);
  } finally {
    f.cleanup();
  }
});

test("CLI dry sync exits nonzero for partial acquisition and writes no authoritative state", () => {
  const f = fixture();
  try {
    const other = join(f.root, "other");
    git(f.root, ["clone", "--no-local", f.repo, other]);
    execute(f.home, "add", [other], { source: "other", ref: "main" });
    install(f.home);
    fs.renameSync(other, other + "-retained");
    const before = authoritative(f.home);
    const child = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "sync", "--home", f.home, "--dry-run"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).toBe(1);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      outcome: "PARTIAL",
      dryRun: true,
      sources: [
        { id: "upstream", outcome: "STAGED" },
        { id: "other", outcome: "ERROR" },
      ],
    });
    expect(authoritative(f.home)).toBe(before);
    fs.renameSync(other + "-retained", other);
    skill(f.repo, "skills/peer", "peer");
    fs.appendFileSync(join(f.skill, "SKILL.md"), "[missing](../outside.md)\n");
    commit(f.repo, "invalid skill with healthy peer");
    const partial = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "sync", "--home", f.home, "--dry-run"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(partial.exitCode).toBe(1);
    expect(JSON.parse(partial.stdout.toString())).toMatchObject({
      outcome: "PARTIAL",
      dryRun: true,
      sources: [
        { id: "upstream", holds: [{ path: ".agents/skills/helper", code: "MISSING_REFERENCE" }] },
        { id: "other", outcome: "STAGED" },
      ],
    });
    expect(authoritative(f.home)).toBe(before);
  } finally {
    f.cleanup();
  }
});

test("current restored baseline omits approval instructions while apply still requires approval", () => {
  const f = fixture();
  try {
    install(f.home);
    const ctx = load(f.home);
    const entry = ctx.lock.entries[0]!;
    entry.approval = null;
    entry.candidate = null;
    entry.outcome = "HELD";
    save(ctx);
    execute(f.home, "sync", []);
    const current = load(f.home).lock.entries[0]!;
    expect(current.outcome).toBe("CURRENT");
    expect(current.reasons).not.toContain("Exact candidate approval required");
    expect(() => execute(f.home, "apply", ["helper"], { hash: current.candidate!.hash })).toThrow(
      expect.objectContaining({ code: "HELD" }),
    );
  } finally {
    f.cleanup();
  }
});

test("unselected holds remain visible without failing current or approval-required staging", () => {
  const f = fixture();
  try {
    install(f.home);
    fs.mkdirSync(join(f.repo, ".cursor-plugin"));
    fs.writeFileSync(join(f.repo, ".cursor-plugin/plugin.json"), "{}");
    commit(f.repo, "unselected unsupported projection");
    const before = authoritative(f.home);
    const dry = execute(f.home, "sync", [], { dryRun: true });
    expect(dry).toMatchObject({
      outcome: "DRY_RUN",
      sources: [
        {
          outcome: "STAGED",
          holds: [{ path: ".cursor-plugin/plugin.json", code: "UNSUPPORTED_FORMAT" }],
        },
      ],
      entries: [{ outcome: "CURRENT" }],
    });
    expect(authoritative(f.home)).toBe(before);
    expect(execute(f.home, "sync", [])).toMatchObject({
      result: { outcome: "STAGED", entries: [{ outcome: "CURRENT" }] },
    });
    editBody(f.skill, "Last line", "Changed upstream");
    commit(f.repo, "new candidate needing approval");
    const accepted = load(f.home).lock.entries[0]!;
    expect(execute(f.home, "sync", [])).toMatchObject({
      result: {
        outcome: "STAGED",
        entries: [{ outcome: "HELD", candidate: { revision: git(f.repo, ["rev-parse", "HEAD"]) } }],
      },
    });
    const current = load(f.home).lock.entries[0]!;
    expect(current.approval).toEqual(accepted.approval);
    expect(current.deployed).toEqual(accepted.deployed);
    expect(current.candidate!.hash).not.toBe(current.approval!.hash);
    const child = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "sync", "--home", f.home, "--dry-run"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      outcome: "DRY_RUN",
      entries: [{ outcome: "HELD", candidate: expect.any(Object) }],
    });
  } finally {
    f.cleanup();
  }
});

for (const malformed of [false, true]) {
  test(`absent selectors stay NOT_FOUND while established custom selection holds with ${malformed ? "malformed" : "missing"} manifest`, () => {
    const f = fixture();
    try {
      skill(f.repo, "custom/healthy", "custom");
      fs.mkdirSync(join(f.repo, ".claude-plugin"));
      const manifest = join(f.repo, ".claude-plugin/plugin.json");
      fs.writeFileSync(manifest, JSON.stringify({ skills: ["./custom/healthy"] }));
      commit(f.repo, "custom skill");
      execute(f.home, "sync", []);
      execute(f.home, "select", ["upstream"], {
        path: "custom/healthy",
        id: "custom",
        install: true,
        reason: "Explicit fixture request",
      });
      const accepted = load(f.home).lock.entries[0]!;
      const deployed = treeHash(readTree(join(f.dest, "custom")));
      if (malformed) fs.writeFileSync(manifest, "{");
      else fs.unlinkSync(manifest);
      commit(f.repo, "manifest unavailable");
      const before = authoritative(f.home);
      expect(execute(f.home, "sync", [], { dryRun: true })).toMatchObject({
        outcome: "PARTIAL",
        entries: [{ candidate: null, outcome: "HELD" }],
      });
      expect(authoritative(f.home)).toBe(before);
      expect(execute(f.home, "sync", [])).toMatchObject({
        result: { outcome: "PARTIAL", entries: [{ candidate: null, outcome: "HELD" }] },
      });
      const held = load(f.home).lock.entries[0]!;
      expect(held).toEqual({
        ...accepted,
        candidate: null,
        outcome: "HELD",
        reasons: expect.any(Array),
      });
      expect(treeHash(readTree(join(f.dest, "custom")))).toBe(deployed);
      if (malformed) expect(held.reasons[0]).toContain(".claude-plugin/plugin.json");
      const unchanged = authoritative(f.home);
      for (const path of ["unrelated/absent", ".agents/skills/absent", "custom/healthy"]) {
        expect(() =>
          execute(f.home, "select", ["upstream"], { path, id: "new", dryRun: true }),
        ).toThrow(
          expect.objectContaining({ code: path === "custom/healthy" ? "EXISTS" : "NOT_FOUND" }),
        );
      }
      expect(authoritative(f.home)).toBe(unchanged);
    } finally {
      f.cleanup();
    }
  });
}

test("overlapping scans deduplicate holds and events while invalid declarations retain safe indices", () => {
  const f = fixture();
  try {
    skill(f.repo, "skills/bad", "bad", "[missing](missing.md)\n");
    fs.symlinkSync("../outside", join(f.repo, "skills/linked"));
    fs.mkdirSync(join(f.repo, ".claude-plugin"));
    fs.writeFileSync(
      join(f.repo, ".claude-plugin/plugin.json"),
      JSON.stringify({ skills: ["../private-value", "/private-value", "./skills", "./skills"] }),
    );
    const inventory = discover(f.repo);
    expect(inventory.holds).toHaveLength(4);
    const declarations = inventory.holds.filter((hold) => hold.code === "INVALID_PLUGIN");
    expect(declarations.map((hold) => hold.declaration)).toEqual(["skills[0]", "skills[1]"]);
    expect(JSON.stringify(declarations)).not.toContain("private-value");
    expect(inventory.holds.filter((hold) => hold.path === "skills/bad")).toHaveLength(1);
    expect(inventory.holds.filter((hold) => hold.path === "skills/linked")).toHaveLength(1);
    commit(f.repo, "overlapping plugin scans");
    execute(f.home, "sync", []);
    const result = execute(f.home, "inventory", ["upstream"]) as {
      holds: unknown[];
      events: unknown[];
    };
    expect(result.holds).toHaveLength(4);
    expect(result.events).toHaveLength(4);
  } finally {
    f.cleanup();
  }
});

test("processed empty observation and unavailable peer report partial while retaining selected history", () => {
  const f = fixture();
  try {
    install(f.home);
    const other = join(f.root, "other");
    git(f.root, ["clone", "--no-local", f.repo, other]);
    execute(f.home, "add", [other], { source: "other", ref: "main" });
    const accepted = load(f.home).lock;
    const deployed = treeHash(readTree(join(f.dest, "helper")));
    fs.renameSync(other, other + "-retained");
    fs.rmSync(f.skill, { recursive: true });
    commit(f.repo, "selected skill removed");
    const before = authoritative(f.home);
    expect(execute(f.home, "sync", [], { dryRun: true })).toMatchObject({
      outcome: "PARTIAL",
      sources: [{ outcome: "PARTIAL" }, { outcome: "ERROR" }],
      entries: [{ candidate: null, outcome: "HELD" }],
    });
    expect(authoritative(f.home)).toBe(before);
    expect(execute(f.home, "sync", [])).toMatchObject({
      result: { outcome: "PARTIAL", sources: [{ outcome: "PARTIAL" }, { outcome: "ERROR" }] },
    });
    const current = load(f.home).lock;
    expect(current.sources[0]!.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(current.sources[1]).toEqual(accepted.sources[1]);
    expect(current.entries[0]).toEqual({
      ...accepted.entries[0]!,
      candidate: null,
      outcome: "HELD",
      reasons: expect.any(Array),
    });
    expect(treeHash(readTree(join(f.dest, "helper")))).toBe(deployed);
  } finally {
    f.cleanup();
  }
});
