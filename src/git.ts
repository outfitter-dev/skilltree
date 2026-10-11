import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { fail, type Source, type Tree } from "./model";
import { exists, assertNoSymlinks, treeHash, writeTree } from "./files";

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
export function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      env: gitEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 10_000_000,
    },
  ).trim();
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
  else if (git(dir, ["remote", "get-url", "origin"]) !== repo)
    fail("SOURCE_MISMATCH", "Acquired repository remote changed");
  assertNoSymlinks(join(dir, ".git"));
  if (git(dir, ["rev-parse", "--show-toplevel"]) !== dir)
    fail("SOURCE_MISMATCH", "Acquired source belongs to another checkout");
  if (!newClone && git(dir, ["status", "--porcelain", "--untracked-files=all", "--ignored"]))
    fail("SOURCE_DIRTY", "Preserve changes in the acquired source before syncing");
  git(dir, ["fetch", "--no-tags", "origin", ref]);
  const revision = git(dir, ["rev-parse", "FETCH_HEAD^{commit}"]);
  git(dir, ["checkout", "--detach", revision]);
  return { id, repository: repo, ref, revision };
}
export function recordLocal(home: string, id: string, tree: Tree): string {
  const dir = join(home, "edits", id);
  assertNoSymlinks(dir);
  if (!exists(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-b", "skilltree-local"]);
  }
  assertNoSymlinks(join(dir, ".git"));
  if (git(dir, ["rev-parse", "--show-toplevel"]) !== dir)
    fail("LOCAL_HISTORY_INVALID", "Local history belongs to another checkout");
  if (git(dir, ["status", "--porcelain"]))
    fail(
      "LOCAL_HISTORY_DIRTY",
      "Preserve and reconcile edits in local history before capture/apply",
    );
  // This directory is exclusively generated history, never an upstream checkout.
  for (const name of fs.readdirSync(dir))
    if (name !== ".git") fs.rmSync(join(dir, name), { recursive: true });
  writeTree(dir, tree);
  git(dir, ["add", "--all", "--force"]);
  git(dir, ["commit", "--allow-empty", "-m", `Capture content ${treeHash(tree)}`]);
  return git(dir, ["rev-parse", "HEAD"]);
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
        stdio: ["ignore", "pipe", "pipe"],
      });
      tree[path] = { data: result.toString("base64"), executable: l.executable };
    } catch {
      conflicts.push(path);
    }
  }
  return { tree: conflicts.length ? null : tree, conflicts };
}
