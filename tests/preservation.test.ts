import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { git } from "../src/git";
import { execute } from "../src/service";
import { load } from "../src/state";
import { applyEntry, recover } from "../src/deployment";
import { fixture, install, editBody, commit, candidate, authoritative } from "./helpers";

function prepared() {
  const f = fixture();
  install(f.home);
  editBody(join(f.dest, "helper"), "First line", "Local first");
  execute(f.home, "capture", ["helper"]);
  editBody(f.skill, "Last line", "Upstream last");
  commit(f.repo, "upstream update");
  execute(f.home, "sync", []);
  execute(f.home, "approve", ["helper"], {
    hash: candidate(f.home),
    reason: "Reviewed fixture update",
  });
  return { ...f, history: join(f.home, "edits/helper"), digest: candidate(f.home) };
}

function holds(f: ReturnType<typeof prepared>, code: string) {
  const before = authoritative(f.home);
  for (const dryRun of [true, false]) {
    for (const command of ["capture", "apply"]) {
      expect(() => execute(f.home, command, ["helper"], { dryRun, hash: f.digest })).toThrow(
        expect.objectContaining({ code }),
      );
      expect(authoritative(f.home)).toBe(before);
    }
  }
  expect(execute(f.home, "doctor", [])).toMatchObject({ outcome: "ERROR" });
  expect(authoritative(f.home)).toBe(before);
}

for (const kind of ["ignored", "untracked", "assume-unchanged", "skip-worktree"]) {
  test(`capture/apply and their dry runs preserve ${kind} local history work`, () => {
    const f = prepared();
    try {
      let path: string;
      if (kind === "ignored" || kind === "untracked") {
        fs.mkdirSync(join(f.history, "private-notes"));
        path = join(f.history, "private-notes/uncommitted.txt");
        if (kind === "ignored")
          fs.appendFileSync(join(f.history, ".git/info/exclude"), "\nprivate-notes/\n");
      } else {
        git(f.history, ["update-index", `--${kind}`, "SKILL.md"]);
        path = join(f.history, "SKILL.md");
      }
      fs.appendFileSync(path, "unique uncommitted work\n");
      const bytes = fs.readFileSync(path);
      if (kind !== "untracked") expect(git(f.history, ["status", "--porcelain"])).toBe("");
      holds(f, "LOCAL_HISTORY_DIRTY");
      expect(fs.readFileSync(path)).toEqual(bytes);
    } finally {
      f.cleanup();
    }
  });
}

for (const kind of ["missing", "invalid"]) {
  test(`dry and real writes reject ${kind} local history`, () => {
    const f = prepared();
    try {
      if (kind === "missing") fs.renameSync(f.history, join(f.root, "retained-history"));
      else fs.renameSync(join(f.history, ".git"), join(f.root, "retained-git"));
      holds(f, "LOCAL_HISTORY_INVALID");
    } finally {
      f.cleanup();
    }
  });
}

for (const kind of ["tracked", "ignored", "assume-unchanged", "remote"]) {
  test(`sync dry run checks the durable source for ${kind} changes`, () => {
    const f = prepared();
    try {
      const source = join(f.home, "repos/upstream");
      if (kind === "remote") git(source, ["remote", "set-url", "origin", f.root]);
      else if (kind === "ignored") {
        fs.appendFileSync(join(source, ".git/info/exclude"), "\nnote.txt\n");
        fs.writeFileSync(join(source, "note.txt"), "unique notes");
      } else {
        if (kind === "assume-unchanged")
          git(source, ["update-index", "--assume-unchanged", ".agents/skills/helper/SKILL.md"]);
        fs.appendFileSync(join(source, ".agents/skills/helper/SKILL.md"), "uncommitted\n");
      }
      const before = authoritative(f.home);
      for (const dryRun of [true, false]) {
        expect(() => execute(f.home, "sync", [], { dryRun })).toThrow(
          expect.objectContaining({ code: kind === "remote" ? "SOURCE_MISMATCH" : "SOURCE_DIRTY" }),
        );
        expect(authoritative(f.home)).toBe(before);
      }
    } finally {
      f.cleanup();
    }
  });
}

test("recovery preserves ignored history work and permits a clean generated commit ahead", () => {
  const f = prepared();
  try {
    const ctx = load(f.home);
    expect(() =>
      applyEntry(ctx, ctx.lock.entries[0]!, f.digest, false, () => {
        fs.appendFileSync(join(f.history, ".git/info/exclude"), "\nnotes.txt\n");
        fs.writeFileSync(join(f.history, "notes.txt"), "retained during recovery");
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");
    recover(load(f.home), false);
    expect(fs.readFileSync(join(f.history, "notes.txt"), "utf8")).toBe("retained during recovery");
    holds(f, "LOCAL_HISTORY_DIRTY");
    fs.unlinkSync(join(f.history, "notes.txt"));
    expect(execute(f.home, "apply", ["helper"], { hash: f.digest })).toMatchObject({
      result: { outcome: "UPDATED" },
    });
  } finally {
    f.cleanup();
  }
});

test("filesystem mode preflight does not rely on Git core.filemode", () => {
  const f = prepared();
  try {
    git(f.history, ["config", "core.filemode", "false"]);
    const path = join(f.history, "scripts/run.sh");
    fs.chmodSync(path, 0o644);
    expect(git(f.history, ["status", "--porcelain"])).toBe("");
    holds(f, "LOCAL_HISTORY_DIRTY");
    expect(fs.statSync(path).mode & 0o111).toBe(0);
  } finally {
    f.cleanup();
  }
});
