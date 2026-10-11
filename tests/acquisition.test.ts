import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { git, committedTree, sourcePath } from "../src/git";
import { readTree, treeHash } from "../src/files";
import { execute } from "../src/service";
import { load, save } from "../src/state";
import { fixture, install, editBody, commit, authoritative } from "./helpers";

test("unsupported upstream validation leaves accepted sources intact and corrected sync retries", () => {
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
    for (const dryRun of [true, false]) {
      expect(() => execute(f.home, "sync", [], { dryRun })).toThrow(
        expect.objectContaining({ code: "UNSUPPORTED_DEPENDENCY" }),
      );
      expect(authoritative(f.home)).toBe(before);
      expect(git(sourcePath(f.home, accepted), ["rev-parse", "HEAD"])).toBe(accepted.revision);
    }
    fs.writeFileSync(join(f.skill, "SKILL.md"), original + "\nFixed upstream\n");
    commit(f.repo, "fixed dependency");
    expect(execute(f.home, "sync", [], { dryRun: true })).toMatchObject({ outcome: "DRY_RUN" });
    expect(authoritative(f.home)).toBe(before);
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

test("later acquisition failure leaves all accepted source revisions unchanged", () => {
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
    const before = authoritative(f.home);
    for (const dryRun of [true, false]) {
      expect(() => execute(f.home, "sync", [], { dryRun })).toThrow();
      expect(authoritative(f.home)).toBe(before);
      for (const source of accepted)
        expect(git(sourcePath(f.home, source), ["rev-parse", "HEAD"])).toBe(source.revision);
    }
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
    expect(treeHash(committedTree(history, entry.local!.commit))).toBe(entry.local!.hash);
    expect(Object.keys(committedTree(history, entry.local!.commit))).toContain("SKILL.md");
    for (const name of names)
      expect(Object.keys(committedTree(history, entry.local!.commit))).toContain(name);
    expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "OK" });
    for (const name of names.slice(0, 4)) fs.unlinkSync(join(f.dest, "helper", name));
    execute(f.home, "capture", ["helper"]);
    entry = load(f.home).lock.entries[0]!;
    expect(treeHash(committedTree(history, entry.local!.commit))).toBe(
      treeHash(readTree(join(f.dest, "helper"))),
    );
    for (const name of names.slice(0, 4))
      expect(Object.keys(committedTree(history, entry.local!.commit))).not.toContain(name);
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
