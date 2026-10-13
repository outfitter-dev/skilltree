import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { git, committedTree, sourcePath } from "../src/git";
import { readTree, treeHash } from "../src/files";
import { execute } from "../src/service";
import { load, save } from "../src/state";
import { fixture, install, editBody, commit, authoritative } from "./helpers";

test("invalid upstream skills retain accepted skill histories and corrected sync retries", () => {
  const f = fixture();
  try {
    install(f.home);
    const original = fs.readFileSync(join(f.skill, "SKILL.md"), "utf8");
    const accepted = load(f.home).lock.sources[0]!;
    const before = authoritative(f.home);
    fs.writeFileSync(
      join(f.skill, "SKILL.md"),
      original.replace(
        "description: Fixture helper",
        "description: Fixture helper\ndependencies: [external]",
      ),
    );
    commit(f.repo, "unsupported dependency");
    const originalEntry = load(f.home).lock.entries[0]!;
    const dry = execute(f.home, "sync", [], { dryRun: true });
    expect(dry).toMatchObject({
      outcome: "PARTIAL",
      dryRun: true,
      sources: [{ holds: [{ code: "UNSUPPORTED_DEPENDENCY", path: ".agents/skills/helper" }] }],
    });
    expect(authoritative(f.home)).toBe(before);
    execute(f.home, "sync", []);
    expect(load(f.home).lock.entries[0]).toEqual({
      ...originalEntry,
      candidate: null,
      outcome: "HELD",
      reasons: expect.any(Array),
    });
    expect(git(sourcePath(f.home, accepted), ["rev-parse", "HEAD"])).toBe(accepted.revision);
    const heldState = authoritative(f.home);
    fs.writeFileSync(join(f.skill, "SKILL.md"), original + "\nFixed upstream\n");
    commit(f.repo, "fixed dependency");
    expect(execute(f.home, "sync", [], { dryRun: true })).toMatchObject({ outcome: "DRY_RUN" });
    expect(authoritative(f.home)).toBe(heldState);
    execute(f.home, "sync", []);
    const current = load(f.home).lock.sources[0]!;
    expect(current.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(git(sourcePath(f.home, current), ["rev-parse", "HEAD"])).toBe(current.revision);
    expect(git(sourcePath(f.home, accepted), ["rev-parse", "HEAD"])).toBe(accepted.revision);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});

test("later acquisition failure holds that source while healthy sources stage atomically", () => {
  const f = fixture();
  try {
    const other = join(f.root, "other-upstream");
    git(f.root, ["clone", "--no-local", f.repo, other]);
    execute(f.home, "add", [other], { source: "second", ref: "main" });
    install(f.home);
    const accepted = load(f.home).lock.sources;
    editBody(f.skill, "Last line", "New upstream");
    commit(f.repo, "new upstream");
    fs.renameSync(other, other + "-retained");
    const originalEntries = load(f.home).lock.entries;
    const dry = execute(f.home, "sync", [], { dryRun: true }) as {
      sources: { id: string; outcome: string }[];
    };
    expect(dry.sources).toContainEqual(expect.objectContaining({ id: "second", outcome: "ERROR" }));
    expect(load(f.home).lock.sources).toEqual(accepted);
    const real = execute(f.home, "sync", []) as {
      result: { outcome: string; sources: { id: string; outcome: string }[] };
    };
    expect(real.result.outcome).toBe("PARTIAL");
    expect(real.result.sources).toContainEqual(
      expect.objectContaining({ id: "second", outcome: "ERROR" }),
    );
    expect(load(f.home).lock.sources[1]).toEqual(accepted[1]);
    expect(load(f.home).lock.sources[0]!.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(load(f.home).lock.entries[0]!.approval).toEqual(originalEntries[0]!.approval);
    fs.renameSync(other + "-retained", other);
    execute(f.home, "sync", []);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});

test("process exit while publishing a generation leaves accepted checkouts usable and preserves user notes", () => {
  const f = fixture();
  try {
    install(f.home);
    const accepted = load(f.home).lock.sources[0]!;
    editBody(f.skill, "Last line", "Interrupted upstream");
    commit(f.repo, "interrupted upstream");
    const tools = join(f.root, "git-shim");
    fs.mkdirSync(tools);
    const actualGit = Bun.which("git")!;
    const quotedGit = "'" + actualGit.replaceAll("'", "'\\''") + "'";
    const quotedAccepted = "'" + sourcePath(f.home, accepted).replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(
      join(tools, "git"),
      `#!/bin/sh
${quotedGit} "$@"
result=$?
case "$PWD" in */state/repos/upstream-*) if [ "$PWD" != ${quotedAccepted} ]; then kill -KILL "$PPID"; fi;; esac
exit "$result"
`,
      { mode: 0o755 },
    );
    const child = Bun.spawnSync([process.execPath, "src/cli.ts", "sync", "--home", f.home], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: tools + ":" + process.env.PATH },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).not.toBe(0);
    expect(load(f.home).lock.sources[0]).toEqual(accepted);
    expect(git(sourcePath(f.home, accepted), ["rev-parse", "HEAD"])).toBe(accepted.revision);
    const generations = fs
      .readdirSync(join(f.home, "repos"))
      .filter(
        (name) =>
          name.startsWith("upstream-") && name !== sourcePath(f.home, accepted).split("/").at(-1),
      );
    expect(generations).toHaveLength(1);
    const orphan = join(f.home, "repos", generations[0]!);
    fs.writeFileSync(join(orphan, "unique-notes.txt"), "preserve interrupted generation notes");
    const recovered = Bun.spawnSync(
      [process.execPath, "src/cli.ts", "recover", "--home", f.home, "--unlock"],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(recovered.exitCode).toBe(0);
    execute(f.home, "sync", []);
    expect(fs.readFileSync(join(orphan, "unique-notes.txt"), "utf8")).toBe(
      "preserve interrupted generation notes",
    );
    const current = load(f.home).lock.sources[0]!;
    expect(sourcePath(f.home, current)).not.toBe(orphan);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
    fs.appendFileSync(
      join(sourcePath(f.home, current), ".agents/skills/helper/SKILL.md"),
      "user work\n",
    );
    const before = authoritative(f.home);
    for (const dryRun of [true, false]) {
      expect(() => execute(f.home, "sync", [], { dryRun })).toThrow(
        expect.objectContaining({ code: "SOURCE_DIRTY" }),
      );
      expect(authoritative(f.home)).toBe(before);
    }
  } finally {
    f.cleanup();
  }
});

test("literal support filenames and deletions produce complete committed snapshots", () => {
  const f = fixture();
  try {
    const names = [
      ":(exclude)SKILL.md",
      ":leading",
      "*",
      "[abc]",
      "white space",
      " leading space",
      "\nleading newline",
      "trailing space ",
      "line\nbreak",
      "trailing\n",
    ];
    for (const name of names) fs.writeFileSync(join(f.skill, name), `support: ${name}\n`);
    commit(f.repo, "literal supporting filenames");
    execute(f.home, "sync", []);
    install(f.home);
    editBody(join(f.dest, "helper"), "First line", "Local first");
    execute(f.home, "capture", ["helper"]);
    const history = join(f.home, "edits/helper");
    let entry = load(f.home).lock.entries[0]!;
    const captured = committedTree(history, entry.local!.commit);
    expect(treeHash(captured)).toBe(entry.local!.hash);
    expect(Object.keys(captured)).toContain("SKILL.md");
    for (const name of names) expect(Object.keys(captured)).toContain(name);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
    for (const name of names.slice(0, 4)) fs.unlinkSync(join(f.dest, "helper", name));
    execute(f.home, "capture", ["helper"]);
    entry = load(f.home).lock.entries[0]!;
    const recaptured = committedTree(history, entry.local!.commit);
    expect(treeHash(recaptured)).toBe(treeHash(readTree(join(f.dest, "helper"))));
    for (const name of names.slice(0, 4)) expect(Object.keys(recaptured)).not.toContain(name);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});

test("capture refuses success if Git attributes transform the intended snapshot", () => {
  const f = fixture();
  try {
    fs.writeFileSync(join(f.skill, ".gitattributes"), "support.txt text eol=lf\n");
    fs.writeFileSync(join(f.skill, "support.txt"), "original\n");
    commit(f.repo, "declared text normalization");
    execute(f.home, "sync", []);
    install(f.home);
    const accepted = load(f.home).lock.entries[0]!;
    fs.writeFileSync(join(f.dest, "helper/support.txt"), "local CRLF\r\n");
    expect(() => execute(f.home, "capture", ["helper"])).toThrow(
      expect.objectContaining({ code: "LOCAL_HISTORY_INVALID" }),
    );
    expect(load(f.home).lock.entries[0]).toEqual(accepted);
    expect(fs.readFileSync(join(f.dest, "helper/support.txt"), "utf8")).toBe("local CRLF\r\n");
    expect(fs.readFileSync(join(f.home, "edits/helper/support.txt"), "utf8")).toBe(
      "local CRLF\r\n",
    );
  } finally {
    f.cleanup();
  }
});

test("failed initial add can retry and legacy source locations remain compatible", () => {
  const f = fixture();
  try {
    const before = authoritative(f.home);
    expect(() =>
      execute(f.home, "add", [f.repo], { source: "second", ref: "missing-ref" }),
    ).toThrow();
    expect(authoritative(f.home)).toBe(before);
    execute(f.home, "add", [f.repo], { source: "second", ref: "main" });
    const ctx = load(f.home);
    const source = ctx.lock.sources[0]!;
    fs.renameSync(sourcePath(f.home, source), join(f.home, "repos", source.id));
    delete source.checkout;
    save(ctx);
    install(f.home);
    execute(f.home, "sync", []);
    expect(load(f.home).lock.sources[0]!.checkout).toBeDefined();
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});

function repositoryLinks(repo: string) {
  fs.writeFileSync(join(repo, "README.md"), "Repository notes\n");
  fs.mkdirSync(join(repo, "docs/nested"), { recursive: true });
  fs.mkdirSync(join(repo, "shared"));
  fs.writeFileSync(join(repo, "shared/notes.md"), "Shared notes\n");
  const links = {
    "CLAUDE.md": "README.md",
    "docs/nested/readme.md": "../../README.md",
    "docs/shared": "../shared",
  };
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, join(repo, name));
  commit(repo, "repository metadata links");
  return links;
}

function expectRepositoryLinks(root: string, links: Record<string, string>) {
  for (const [name, target] of Object.entries(links)) {
    expect(fs.readlinkSync(join(root, name))).toBe(target);
    expect(fs.existsSync(join(root, name))).toBe(true);
  }
  expect(git(root, ["status", "--porcelain", "--untracked-files=all", "--ignored"])).toBe("");
}

test("add preserves root and nested repository symlinks verbatim outside selected skills", () => {
  const f = fixture();
  try {
    const links = repositoryLinks(f.repo);
    const before = authoritative(f.home);
    expect(
      execute(f.home, "add", [f.repo], { source: "links", ref: "main", dryRun: true }),
    ).toMatchObject({ outcome: "WOULD_ADD" });
    expect(authoritative(f.home)).toBe(before);
    execute(f.home, "add", [f.repo], { source: "links", ref: "main" });
    const source = load(f.home).lock.sources.find((item) => item.id === "links")!;
    expectRepositoryLinks(sourcePath(f.home, source), links);
    expect(source.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    execute(f.home, "select", ["links"], {
      path: ".agents/skills/helper",
      id: "linked-helper",
      install: true,
      reason: "Explicit installation of a skill from a linked repository",
    });
    expect(fs.existsSync(join(f.dest, "linked-helper/SKILL.md"))).toBe(true);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});

test("sync preserves newly introduced repository links and dry runs leave state unchanged", () => {
  const f = fixture();
  try {
    install(f.home);
    const accepted = load(f.home).lock.sources[0]!;
    const links = repositoryLinks(f.repo);
    const before = authoritative(f.home);
    expect(execute(f.home, "sync", [], { dryRun: true })).toMatchObject({ outcome: "DRY_RUN" });
    expect(authoritative(f.home)).toBe(before);
    execute(f.home, "sync", []);
    const current = load(f.home).lock.sources[0]!;
    expectRepositoryLinks(sourcePath(f.home, current), links);
    expect(current.revision).toBe(git(f.repo, ["rev-parse", "HEAD"]));
    expect(git(sourcePath(f.home, accepted), ["rev-parse", "HEAD"])).toBe(accepted.revision);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
    const after = authoritative(f.home);
    expect(execute(f.home, "sync", [], { dryRun: true })).toMatchObject({ outcome: "DRY_RUN" });
    expect(authoritative(f.home)).toBe(after);
  } finally {
    f.cleanup();
  }
});

for (const [name, target] of [
  ["outside.md", "../../../README.md"],
  ["support", "../../../shared"],
]) {
  test(`repository acquisition still rejects selected-skill symlinks: ${name}`, () => {
    const f = fixture();
    try {
      install(f.home);
      repositoryLinks(f.repo);
      fs.symlinkSync(target!, join(f.skill, name!));
      commit(f.repo, "unsupported selected skill link");
      const before = authoritative(f.home);
      const previous = load(f.home).lock.entries[0]!;
      expect(execute(f.home, "sync", [], { dryRun: true })).toMatchObject({
        outcome: "PARTIAL",
        sources: [{ holds: [{ path: ".agents/skills/helper", code: "UNSAFE_TREE" }] }],
      });
      expect(authoritative(f.home)).toBe(before);
      execute(f.home, "sync", []);
      expect(load(f.home).lock.entries[0]).toEqual({
        ...previous,
        candidate: null,
        outcome: "HELD",
        reasons: expect.any(Array),
      });
      execute(f.home, "add", [f.repo], { source: "unsafe", ref: "main" });
      expectRepositoryLinks(
        sourcePath(f.home, load(f.home).lock.sources.find((s) => s.id === "unsafe")!),
        {
          [".agents/skills/helper/" + name!]: target!,
        },
      );
      const added = authoritative(f.home);
      for (const dryRun of [true, false]) {
        expect(() =>
          execute(f.home, "select", ["unsafe"], {
            path: ".agents/skills/helper",
            id: "unsafe-helper",
            dryRun,
          }),
        ).toThrow(expect.objectContaining({ code: "UNSAFE_TREE" }));
        expect(authoritative(f.home)).toBe(added);
      }
    } finally {
      f.cleanup();
    }
  });
}

test("unchanged sync reuses accepted generations without discarding retained notes", () => {
  const f = fixture();
  try {
    install(f.home);
    const accepted = load(f.home).lock.sources[0]!;
    const count = fs.readdirSync(join(f.home, "repos")).length;
    const retained = join(f.home, "repos/unowned-notes");
    fs.mkdirSync(retained);
    fs.writeFileSync(join(retained, "note.txt"), "unknown work must survive");
    for (let run = 0; run < 3; run++) execute(f.home, "sync", []);
    expect(load(f.home).lock.sources[0]).toEqual(accepted);
    expect(fs.readdirSync(join(f.home, "repos"))).toHaveLength(count + 1);
    expect(fs.readFileSync(join(retained, "note.txt"), "utf8")).toBe("unknown work must survive");
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
  } finally {
    f.cleanup();
  }
});
