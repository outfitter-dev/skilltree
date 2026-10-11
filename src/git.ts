import { lockedStdio } from "./lock-descriptor";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail, type Entry, type Source, type Tree } from "./model";
import { exists, assertNoSymlinks, treeHash, writeTree, readTree, getObject } from "./files";

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_AUTHOR_NAME = "Skilltree";
  env.GIT_AUTHOR_EMAIL = "skilltree@localhost";
  env.GIT_COMMITTER_NAME = "Skilltree";
  env.GIT_COMMITTER_EMAIL = "skilltree@localhost";
  return env;
}
export function gitBytes(cwd: string, args: string[], input?: Buffer): Buffer {
  return execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "gc.auto=0",
      ...args,
    ],
    {
      cwd,
      input,
      env: gitEnvironment(),
      stdio: input ? ["pipe", "pipe", "pipe", ...lockedStdio().slice(3)] : lockedStdio(),
      timeout: 60_000,
      maxBuffer: 10_000_000,
    },
  );
}
export function git(cwd: string, args: string[]): string {
  return gitBytes(cwd, args).toString("utf8").trim();
}

export function sourcePath(home: string, source: Source): string {
  return join(home, "repos", source.checkout ? `${source.id}-${source.checkout}` : source.id);
}

export function committedTree(dir: string, revision: string): Tree {
  const tree: Tree = Object.create(null);
  for (const item of gitBytes(dir, ["ls-tree", "-r", "-z", "--full-tree", revision])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)) {
    const split = item.indexOf("\t");
    const [mode, type, oid] = item.slice(0, split).split(" ");
    if (split < 0 || type !== "blob" || !["100644", "100755"].includes(mode!))
      fail("LOCAL_HISTORY_INVALID", "Local commit contains an unsupported file type");
    tree[item.slice(split + 1)] = {
      data: gitBytes(dir, ["cat-file", "blob", oid!]).toString("base64"),
      executable: mode === "100755",
    };
  }
  return tree;
}

export function repository(value: string): string {
  if (value.startsWith("-") || ["\0", "\n", "\r"].some((part) => value.includes(part)))
    fail("INVALID_SOURCE", "Invalid Git repository");
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value) && !exists(value))
    return `https://github.com/${value}.git`;
  if (exists(value)) return assertNoSymlinks(resolve(value));
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(
      "INVALID_SOURCE",
      "Use a local Git directory, owner/repo, or credential-free HTTPS URL",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    fail("INVALID_SOURCE", "Only credential-free HTTPS Git URLs are supported");
  return url.toString();
}
export function acquire(home: string, id: string, repo: string, ref: string): Source {
  if (ref.startsWith("-") || !/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.includes(".."))
    fail("INVALID_REF", "Unsupported Git ref");
  const dir = join(home, "repos", id);
  assertNoSymlinks(dir);
  fs.mkdirSync(join(home, "repos"), { recursive: true });
  const newClone = !exists(dir);
  if (newClone)
    git(home, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", repo, dir]);
  if (!newClone) preflightSource(dir, repo);
  git(dir, ["fetch", "--no-tags", "origin", ref]);
  const revision = git(dir, ["rev-parse", "FETCH_HEAD^{commit}"]);
  git(dir, ["checkout", "--detach", revision]);
  return { id, repository: repo, ref, revision };
}
// These preflights only read durable state, including ignored files and index flags.
export function preflightSource(dir: string, repo: string, revision?: string): void {
  assertNoSymlinks(dir);
  assertNoSymlinks(join(dir, ".git"));
  if (
    !fs.statSync(join(dir, ".git")).isDirectory() ||
    git(dir, ["rev-parse", "--show-toplevel"]) !== dir ||
    resolve(dir, git(dir, ["rev-parse", "--git-common-dir"])) !== join(dir, ".git") ||
    git(dir, ["remote", "get-url", "origin"]) !== repo
  )
    fail("SOURCE_MISMATCH", "Acquired source belongs to another repository");
  const concealed = git(dir, ["ls-files", "-v", "-z"])
    .split("\0")
    .some((line) => line && (line[0] === "S" || /[a-z]/.test(line[0]!)));
  if (
    (revision && git(dir, ["rev-parse", "HEAD"]) !== revision) ||
    concealed ||
    git(dir, ["status", "--porcelain", "--untracked-files=all", "--ignored"])
  )
    fail(
      "SOURCE_DIRTY",
      "Acquired source changed outside Skilltree; preserve and reconcile it before syncing",
    );
}

export function localPath(home: string, id: string, local: Entry["local"]): string {
  return join(home, "edits", local?.checkout ? `${id}-${local.checkout}` : id);
}
export function preflightLocal(home: string, id: string, local: Entry["local"]): Tree | null {
  const dir = assertNoSymlinks(localPath(home, id, local));
  if (!exists(dir)) {
    if (local) fail("LOCAL_HISTORY_INVALID", "Recorded local history is missing");
    return null;
  }
  if (!local) fail("LOCAL_HISTORY_INVALID", "Unrecognized local history must be reconciled first");
  assertNoSymlinks(join(dir, ".git"));
  let previous: Tree;
  try {
    if (
      !fs.statSync(join(dir, ".git")).isDirectory() ||
      git(dir, ["rev-parse", "--show-toplevel"]) !== dir ||
      resolve(dir, git(dir, ["rev-parse", "--git-common-dir"])) !== join(dir, ".git") ||
      git(dir, ["cat-file", "-t", local.commit]) !== "commit"
    )
      fail("LOCAL_HISTORY_INVALID", "Local history belongs to another checkout");
    git(dir, ["merge-base", "--is-ancestor", local.commit, "HEAD"]);
    // Recovery can leave a generated commit ahead of the accepted lock entry.
    // Validate that commit against its immutable object before reusing its files.
    const match = /^Capture content ([a-f0-9]{64})$/.exec(git(dir, ["log", "-1", "--format=%s"]));
    if (!match) fail("LOCAL_HISTORY_INVALID", "Local history has an unrecognized commit");
    previous = getObject(home, match[1]!);
    if (treeHash(committedTree(dir, "HEAD")) !== treeHash(previous))
      fail("LOCAL_HISTORY_INVALID", "Recorded commit differs from its complete content snapshot");
  } catch {
    return fail("LOCAL_HISTORY_INVALID", "Local Git provenance is missing or unrecognized");
  }
  const concealed = git(dir, ["ls-files", "-v", "-z"])
    .split("\0")
    .some((line) => line && (line[0] === "S" || /[a-z]/.test(line[0]!)));
  if (concealed || git(dir, ["status", "--porcelain", "--untracked-files=all", "--ignored"]))
    fail(
      "LOCAL_HISTORY_DIRTY",
      "Preserve and reconcile edits in local history before capture/apply",
    );
  // Compare bytes and modes directly: assume-unchanged/skip-worktree can hide edits.
  try {
    const tracked = gitBytes(dir, ["ls-files", "-z"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    if (
      JSON.stringify(tracked) !== JSON.stringify(Object.keys(previous).sort()) ||
      treeHash(readTree(dir, true)) !== treeHash(previous)
    )
      fail("LOCAL_HISTORY_DIRTY", "Local history content differs from its recorded snapshot");
  } catch {
    return fail(
      "LOCAL_HISTORY_DIRTY",
      "Preserve and reconcile local history files before capture/apply",
    );
  }
  return previous;
}

export function recordLocal(home: string, id: string, tree: Tree, local: Entry["local"]): string {
  const previous = preflightLocal(home, id, local);
  const dir = localPath(home, id, local);
  if (!previous) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-b", "skilltree-local"]);
  }
  // Remove only files proven to belong to the generated snapshot. New unrelated
  // files appearing after preflight are never recursively cleared.
  const parents = new Set<string>();
  for (const path of Object.keys(previous ?? {})) {
    const target = join(dir, path);
    fs.unlinkSync(target);
    for (let parent = dirname(target); parent !== dir; parent = dirname(parent))
      parents.add(parent);
  }
  for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  }
  writeTree(dir, tree);
  const owned = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(tree)])];
  git(dir, ["add", "--all", "--force", "--", ...owned]);
  git(dir, ["commit", "--allow-empty", "-m", `Capture content ${treeHash(tree)}`]);
  const revision = git(dir, ["rev-parse", "HEAD"]);
  if (treeHash(committedTree(dir, revision)) !== treeHash(tree))
    fail("LOCAL_HISTORY_INVALID", "Committed files differ from the intended complete snapshot");
  return revision;
}
export function mergeTrees(
  base: Tree,
  local: Tree,
  upstream: Tree,
  scratch: string,
): { tree: Tree | null; conflicts: string[] } {
  const tree: Tree = {};
  const conflicts: string[] = [];
  for (const path of [
    ...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(upstream)]),
  ].sort()) {
    const b = base[path];
    const l = local[path];
    const u = upstream[path];
    const equal = (a: unknown, c: unknown) => JSON.stringify(a) === JSON.stringify(c);
    if (equal(l, b)) {
      if (u) tree[path] = u;
      continue;
    }
    if (equal(u, b) || equal(l, u)) {
      if (l) tree[path] = l;
      continue;
    }
    if (!b || !l || !u || l.executable !== u.executable) {
      conflicts.push(path);
      continue;
    }
    const files = [l, b, u].map((file, index) => {
      const target = join(scratch, `merge-${index}`);
      fs.writeFileSync(target, Buffer.from(file.data, "base64"));
      return target;
    });
    try {
      const result = execFileSync("git", ["merge-file", "-p", ...files], {
        env: gitEnvironment(),
        maxBuffer: 10_000_000,
        timeout: 10_000,
        stdio: lockedStdio(),
      });
      tree[path] = { data: result.toString("base64"), executable: l.executable };
    } catch {
      conflicts.push(path);
    }
  }
  return { tree: conflicts.length ? null : tree, conflicts };
}
