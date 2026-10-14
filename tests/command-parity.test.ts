import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "../src/service";
import { load, save } from "../src/state";
import { parseCommand, stateHome } from "../src/command-input";
import { chooseSkills, selectedIds, sourceId } from "../src/source-selection";
import { discover } from "../src/discovery";
import { applyEntry } from "../src/deployment";
import { fixture, commit, install, editBody, candidate, body } from "./helpers";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
async function run(args: string[], cwd?: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
function result(value: unknown): any {
  return (value as any).result ?? value;
}
function secondSkill(f: ReturnType<typeof fixture>) {
  const root = join(f.repo, "skills/other");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    join(root, "SKILL.md"),
    "---\nname: other\ndescription: Another fixture\n---\nOther content\n",
  );
  commit(f.repo, "second skill");
  execute(f.home, "plan", []);
}

test("home precedence, source IDs and compatibility values are explicit", () => {
  const previous = process.env.SKILLTREE_HOME;
  try {
    delete process.env.SKILLTREE_HOME;
    expect(stateHome()).toBe("/workspace/skilltree");
    process.env.SKILLTREE_HOME = "/tmp/from-env";
    expect(stateHome()).toBe("/tmp/from-env");
    expect(stateHome("/tmp/explicit")).toBe("/tmp/explicit");
  } finally {
    if (previous === undefined) delete process.env.SKILLTREE_HOME;
    else process.env.SKILLTREE_HOME = previous;
  }
  expect(sourceId("https://github.com/Upper-Owner/Upper_Repo.git")).toBe("upper-owner-upper_repo");
  const parsed = parseCommand([
    "add",
    "owner/repo",
    "-a",
    "cursor",
    "claude",
    "--subagent",
    "worker",
    "--metadata",
    '{"request":true}',
    "-g",
    "-p",
    "--copy",
    "-s",
    "one",
    "two",
    "--all",
  ]);
  expect(parsed.positionals).toEqual(["add", "owner/repo"]);
  expect(parsed.values.skill).toEqual(["one", "two"]);
  expect(parsed.values.yes).toBeUndefined();
  expect(parsed.warnings).toHaveLength(6);
  expect(parseCommand(["ls", "-a", "writer", "--json"]).values.profile).toBe("writer");
  expect(() => parseCommand(["add", "owner/repo", "--metadata"])).toThrow("requires a value");
});

test("read-only add listing needs no initialized home or registration", async () => {
  const f = fixture();
  try {
    const home = join(f.root, "never-created-state");
    const listed = await run([
      "a",
      f.repo,
      "-l",
      "--home",
      home,
      "--agent",
      "cursor",
      "--metadata",
      "{}",
    ]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).skills[0].name).toBe("helper");
    expect(listed.stderr.match(/Warning:/g)).toHaveLength(2);
    expect(fs.existsSync(home)).toBe(false);
    expect(load(f.home).lock.entries).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test("multiple names and --all stage only; explicit yes and reason are both required", () => {
  const f = fixture();
  try {
    secondSkill(f);
    const staged = result(
      execute(f.home, "add", [f.repo], {
        skills: ["helper", "other"],
        all: true,
        reason: "Selection only",
      }),
    );
    expect(staged.entries).toHaveLength(2);
    expect(
      staged.entries.every((e: any) => e.outcome === "HELD" && e.candidate.hash.length === 64),
    ).toBe(true);
    expect(fs.readdirSync(f.dest)).toEqual([]);
    execute(f.home, "add", [f.repo], { skills: ["helper"], yes: true });
    expect(fs.readdirSync(f.dest)).toEqual([]);
    const hash = load(f.home).lock.entries.find((e) => e.id === "helper")!.candidate!.hash;
    execute(f.home, "apply", ["helper"], { hash, reason: "Reviewed complete selection" });
    expect(body(join(f.dest, "helper"))).toContain("First line");
    expect((execute(f.home, "backups", []) as any).backups).toHaveLength(1);
    expect(fs.existsSync(join(f.dest, "other"))).toBe(false);
    execute(f.home, "add", [f.repo], {
      skills: ["other"],
      install: true,
      reason: "Explicit installation",
    });
    expect(fs.existsSync(join(f.dest, "other/SKILL.md"))).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("name ambiguity and destination collisions never guess or partially select", () => {
  const f = fixture();
  try {
    fs.mkdirSync(join(f.repo, "skills/duplicate"), { recursive: true });
    fs.copyFileSync(join(f.skill, "SKILL.md"), join(f.repo, "skills/duplicate/SKILL.md"));
    commit(f.repo, "duplicate projection");
    execute(f.home, "plan", []);
    expect(() => execute(f.home, "add", [f.repo], { skills: ["helper"] })).toThrow(
      "multiple projections",
    );
    expect(load(f.home).lock.entries).toHaveLength(0);
    execute(f.home, "add", [f.repo], { skills: ["skills/duplicate"], id: "copy" });
    expect(load(f.home).lock.entries[0]!.path).toBe("skills/duplicate");
    expect(() =>
      execute(f.home, "add", [f.repo], { skills: [".agents/skills/helper"], id: "copy" }),
    ).toThrow("already owned");
    expect(() => execute(f.home, "plan", ["missing"])).toThrow("Unknown selection");
  } finally {
    f.cleanup();
  }
});

test("root skill and full-depth scans retain exact source-relative paths", () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      join(f.repo, "SKILL.md"),
      "---\nname: root-skill\ndescription: Root fixture\n---\nRoot\n",
    );
    commit(f.repo, "root skill");
    expect(discover(f.repo).skills.map((s) => s.path)).toEqual(["."]);
    expect(discover(f.repo, true).skills.map((s) => s.path)).toEqual([
      ".",
      ".agents/skills/helper",
    ]);
    const home = join(f.root, "deep-state");
    execute(home, "setup", [], {
      destination: join(f.root, "deep-library"),
      exclusive: true,
      runtimeRoot: join(f.root, "deep-runtime"),
      lockBackend: "mkdir",
    });
    execute(home, "add", [f.repo], { fullDepth: true, skills: ["helper"] });
    expect(load(home).lock.sources[0]!.fullDepth).toBe(true);
    execute(home, "plan", ["helper"]);
    expect(load(home).lock.entries[0]!.candidate).not.toBeNull();
  } finally {
    f.cleanup();
  }
});

test("targeted plan preserves peers and combined apply rejects stale hashes or failed backups", () => {
  const f = fixture();
  try {
    secondSkill(f);
    execute(f.home, "add", [f.repo], {
      skills: ["helper", "other"],
      yes: true,
      reason: "Fixture installations",
    });
    const old = candidate(f.home);
    const peer = load(f.home).lock.entries.find((e) => e.id === "other")!;
    editBody(f.skill, "Last line", "Updated upstream");
    commit(f.repo, "update helper");
    execute(f.home, "plan", ["helper"], { yes: true });
    expect(load(f.home).lock.entries.find((e) => e.id === "other")).toEqual(peer);
    expect(body(join(f.dest, "helper"))).not.toContain("Updated upstream");
    expect(() =>
      execute(f.home, "apply", ["helper"], { hash: old, reason: "Stale review" }),
    ).toThrow("current complete");
    const blocker = join(f.dest, "outside");
    fs.mkdirSync(blocker);
    fs.symlinkSync("/outside", join(blocker, "unsupported"));
    expect(() =>
      execute(f.home, "apply", ["helper"], {
        hash: candidate(f.home),
        reason: "Reviewed candidate",
      }),
    ).toThrow();
    expect(body(join(f.dest, "helper"))).not.toContain("Updated upstream");
    fs.unlinkSync(join(blocker, "unsupported"));
    execute(f.home, "plan", ["helper"], { yes: true, reason: "Reviewed complete update" });
    expect(body(join(f.dest, "helper"))).toContain("Updated upstream");
  } finally {
    f.cleanup();
  }
});

test("legacy JSON contracts, aliases, help and scaffold preserve existing files", async () => {
  const f = fixture();
  try {
    const selected = await run([
      "select",
      "upstream",
      "--path",
      ".agents/skills/helper",
      "--id",
      "helper",
      "--home",
      f.home,
    ]);
    expect(selected.exitCode).toBe(0);
    expect(JSON.parse(selected.stdout).result.outcome).toBe("SELECTED");
    expect(selected.stderr.trim().split("\n")).toHaveLength(1);
    expect(selected.stderr).toContain("Deprecated until 0.2");
    const listed = await run(["ls", "--json"], undefined, { SKILLTREE_HOME: f.home });
    expect(JSON.parse(listed.stdout).entries).toHaveLength(1);
    for (const command of ["add", "plan", "snapshot", "remove", "recover", "setup", "init"])
      expect((await run([command, "-h"])).exitCode).toBe(0);
    expect((await run(["-v"])).exitCode).toBe(0);
    const scaffold = await run(["init", "new-skill"], f.root);
    expect(scaffold.exitCode).toBe(0);
    expect(fs.readFileSync(join(f.root, "new-skill/SKILL.md"), "utf8")).toContain(
      "name: new-skill",
    );
    expect((await run(["init", "new-skill"], f.root)).exitCode).toBe(1);
    expect((await run(["init"], f.root)).exitCode).toBe(2);
    expect(fs.existsSync(join(f.root, "SKILL.md"))).toBe(false);
    expect(
      (
        await run([
          "setup",
          "--dest",
          join(f.root, "new-library"),
          "--exclusive-dest",
          "--dry-run",
          "--home",
          join(f.root, "new-state"),
        ])
      ).exitCode,
    ).toBe(0);
  } finally {
    f.cleanup();
  }
});

test("automatic recovery requires quiet-host and retains ambiguous current bytes", () => {
  const f = fixture();
  try {
    install(f.home);
    editBody(f.skill, "Last line", "Upstream update");
    commit(f.repo, "update");
    execute(f.home, "plan", []);
    execute(f.home, "approve", ["helper"], { hash: candidate(f.home), reason: "Reviewed" });
    const ctx = load(f.home);
    expect(() =>
      applyEntry(ctx, ctx.lock.entries[0]!, candidate(f.home), false, () => {
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");
    expect(() => execute(f.home, "plan", [])).toThrow("recover");
    execute(f.home, "plan", [], { quietHost: true });
    expect(body(join(f.dest, "helper"))).toContain("Last line");
    expect(fs.existsSync(join(f.home, "transaction.json"))).toBe(false);
    execute(f.home, "approve", ["helper"], { hash: candidate(f.home), reason: "Reviewed again" });
    const next = load(f.home);
    expect(() =>
      applyEntry(next, next.lock.entries[0]!, candidate(f.home), false, () => {
        fs.mkdirSync(join(f.dest, "helper"));
        fs.writeFileSync(join(f.dest, "helper/SKILL.md"), "Unknown owner bytes");
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");
    expect(() => execute(f.home, "plan", [], { quietHost: true })).toThrow();
    expect(body(join(f.dest, "helper"))).toBe("Unknown owner bytes");
    expect(fs.existsSync(join(f.home, "transaction.json"))).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("remove aliases disambiguate sources and skills; --all remains staging only", async () => {
  const f = fixture();
  try {
    execute(f.home, "select", ["upstream"], {
      path: ".agents/skills/helper",
      id: "upstream",
      install: true,
      reason: "Fixture install",
    });
    const ambiguous = await run(["rm", "upstream", "--home", f.home]);
    expect(ambiguous.exitCode).toBe(1);
    expect(JSON.parse(ambiguous.stderr).outcome).toBe("AMBIGUOUS");
    expect(load(f.home).lock.entries[0]!.removal).toBeUndefined();
    const all = await run(["remove", "--all", "--reason", "Selection alone", "--home", f.home]);
    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout).result.outcome).toBe("REMOVALS_STAGED");
    expect(fs.existsSync(join(f.dest, "upstream/SKILL.md"))).toBe(true);
    expect(load(f.home).lock.entries[0]!.approval).toBeNull();
    const wildcard = await run(["rm", "-s", "*", "--home", f.home]);
    expect(wildcard.exitCode).toBe(0);
    const preview = await run([
      "apply",
      "upstream",
      "--hash",
      candidate(f.home),
      "--reason",
      "Review preview",
      "--dry-run",
      "--home",
      f.home,
    ]);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout).outcome).toBe("WOULD_REMOVE");
    expect(load(f.home).lock.entries[0]!.approval).toBeNull();
    // Planning does not turn a previous removal into an update authorization.
    execute(f.home, "plan", [], { yes: true, reason: "Review updates" });
    expect(fs.existsSync(join(f.dest, "upstream/SKILL.md"))).toBe(true);
  } finally {
    f.cleanup();
  }
});

test("snapshot aliases preserve expected-hash and host-quiescence restore gates", async () => {
  const f = fixture();
  try {
    install(f.home);
    const backup = JSON.parse(
      (await run(["snapshot", "--backup", "--home", f.home])).stdout,
    ).result;
    const listed = await run(["snapshot", "list", "--home", f.home]);
    expect(JSON.parse(listed.stdout).backups.some((p: any) => p.id === backup.snapshot)).toBe(true);
    const removed = result(
      execute(f.home, "remove", [], { skills: ["helper"], yes: true, reason: "Requested removal" }),
    );
    expect(removed.outcome).toBe("REMOVED");
    const before = fs.readFileSync(join(f.home, "skilltree.lock"), "utf8");
    const stale = await run([
      "snapshot",
      "restore",
      backup.snapshot,
      "--expect",
      "0".repeat(64),
      "--quiet-host",
      "--home",
      f.home,
    ]);
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stderr).outcome).toBe("REVERT_STALE");
    expect(fs.readFileSync(join(f.home, "skilltree.lock"), "utf8")).toBe(before);
    const preview = JSON.parse(
      (await run(["snapshot", "restore", backup.snapshot, "--dry-run", "--home", f.home])).stdout,
    );
    expect(
      (
        await run([
          "snapshot",
          "restore",
          backup.snapshot,
          "--expect",
          preview.expected,
          "--home",
          f.home,
        ])
      ).exitCode,
    ).toBe(1);
    const restored = await run([
      "snapshot",
      "restore",
      backup.snapshot,
      "--expect",
      preview.expected,
      "--quiet-host",
      "--home",
      f.home,
    ]);
    expect(restored.exitCode).toBe(0);
    expect(body(join(f.dest, "helper"))).toContain("First line");
    expect(load(f.home).lock.entries[0]!.removal).toBeUndefined();
    expect(load(f.home).lock.entries[0]!.approval).toBeNull();
  } finally {
    f.cleanup();
  }
});

test("qualified names resolve exact repositories and reject duplicate projections", () => {
  const f = fixture();
  try {
    install(f.home);
    const entry = load(f.home).lock.entries[0]!;
    const entries = [entry, { ...entry, id: "second-helper", source: "second" }];
    const sources = [
      { ...load(f.home).lock.sources[0]!, repository: "https://github.com/First/Repo.git" },
      {
        ...load(f.home).lock.sources[0]!,
        id: "second",
        repository: "https://github.com/Second/Repo.git",
      },
    ];
    expect(() => selectedIds(entries, sources, ["helper"])).toThrow("ambiguous");
    expect([...selectedIds(entries, sources, ["Second/Repo@helper"])]).toEqual(["second-helper"]);
    const inventory = discover(f.repo);
    expect(
      chooseSkills(inventory, ["First/Repo@helper"], "https://github.com/First/Repo.git")[0]!.name,
    ).toBe("helper");
    expect(() =>
      chooseSkills(inventory, ["Second/Repo@helper"], "https://github.com/First/Repo.git"),
    ).toThrow("different repository");
  } finally {
    f.cleanup();
  }
});

test("approval cannot mask conflict and automatic recovery holds changed ownership", () => {
  const f = fixture();
  try {
    install(f.home);
    let ctx = load(f.home);
    ctx.lock.entries[0]!.outcome = "CONFLICT";
    save(ctx);
    expect(() =>
      execute(f.home, "apply", ["helper"], {
        hash: candidate(f.home),
        reason: "Does not authorize conflict",
      }),
    ).toThrow("Reconcile");
    expect(load(f.home).lock.entries[0]!.outcome).toBe("CONFLICT");
    ctx.lock.entries[0]!.outcome = "CURRENT";
    save(ctx);
    editBody(f.skill, "Last line", "Changed upstream");
    commit(f.repo, "upstream");
    execute(f.home, "plan", []);
    execute(f.home, "approve", ["helper"], { hash: candidate(f.home), reason: "Reviewed" });
    ctx = load(f.home);
    expect(() =>
      applyEntry(ctx, ctx.lock.entries[0]!, candidate(f.home), false, () => {
        throw new Error("interrupt");
      }),
    ).toThrow("interrupt");
    ctx = load(f.home);
    ctx.lock.entries[0]!.profiles.push("new-owner-metadata");
    save(ctx);
    expect(() => execute(f.home, "plan", [], { quietHost: true })).toThrow("ownership changed");
    expect(fs.existsSync(join(f.home, "transaction.json"))).toBe(true);
    expect(fs.existsSync(join(f.dest, "helper"))).toBe(false);
  } finally {
    f.cleanup();
  }
});
