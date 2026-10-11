import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute, parse } from "node:path";
import { fail, treeSchema, type Tree } from "./model";

export function exists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export function assertNoSymlinks(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, segment);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink())
      fail("UNSAFE_PATH", `Symlink path is unsupported: ${current}`);
  }
  return absolute;
}
export function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
export function atomicJson(path: string, value: unknown): void {
  assertNoSymlinks(path);
  fs.mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, path);
  // Persist directory entries where supported; not a snapshot/power-loss guarantee.
  const directory = fs.openSync(dirname(path), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
export function readJson(path: string): unknown {
  assertNoSymlinks(path);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}
export function readTree(root: string): Tree {
  assertNoSymlinks(root);
  if (!fs.statSync(root).isDirectory()) fail("UNSAFE_TREE", "Skill root is not a directory");
  const tree: Tree = Object.create(null);
  let bytes = 0;
  let count = 0;
  function walk(dir: string, prefix: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if ([".git", "node_modules", "workflow.md", "runs.json"].includes(name))
        fail("RESERVED_FILE", `Unsupported reserved path: ${rel}`);
      const stat = fs.lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        fail("UNSAFE_TREE", `Symlink or special file: ${rel}`);
      if (stat.isDirectory()) {
        walk(path, rel);
        continue;
      }
      bytes += stat.size;
      count++;
      if (stat.size > 10_000_000 || bytes > 50_000_000 || count > 5000)
        fail("TREE_LIMIT", "Skill exceeds file/size limits");
      tree[rel] = {
        data: fs.readFileSync(path).toString("base64"),
        executable: (stat.mode & 0o111) !== 0,
      };
    }
  }
  walk(root, "");
  if (!tree["SKILL.md"]) fail("INVALID_SKILL", "Skill root must contain SKILL.md");
  return treeSchema.parse(tree);
}
export function treeHash(tree: Tree): string {
  const digest = createHash("sha256");
  for (const path of Object.keys(tree).sort()) {
    const file = tree[path]!;
    const bytes = Buffer.from(file.data, "base64");
    digest.update(JSON.stringify([path, file.executable, bytes.length]) + "\n");
    digest.update(bytes);
  }
  return digest.digest("hex");
}
export function writeTree(root: string, tree: Tree): void {
  assertNoSymlinks(root);
  fs.mkdirSync(root, { recursive: true });
  for (const path of Object.keys(tree).sort()) {
    const target = join(root, path);
    assertNoSymlinks(target);
    fs.mkdirSync(dirname(target), { recursive: true });
    const file = tree[path]!;
    fs.writeFileSync(target, Buffer.from(file.data, "base64"), {
      flag: "wx",
      mode: file.executable ? 0o755 : 0o644,
    });
    fs.chmodSync(target, file.executable ? 0o755 : 0o644);
  }
}
export function liveHash(path: string): string | null {
  return exists(path) ? treeHash(readTree(path)) : null;
}
export function putObject(home: string, tree: Tree): string {
  const digest = treeHash(tree);
  const path = join(home, "objects", `${digest}.json`);
  if (exists(path)) {
    getObject(home, digest);
  } else {
    atomicJson(path, tree);
  }
  return digest;
}
export function getObject(home: string, digest: string): Tree {
  if (!/^[a-f0-9]{64}$/.test(digest)) fail("INVALID_HASH", "Invalid object hash");
  const tree = treeSchema.parse(readJson(join(home, "objects", `${digest}.json`)));
  if (treeHash(tree) !== digest) fail("OBJECT_CORRUPT", `Content object does not match ${digest}`);
  return tree;
}
export function triage(old: Tree | null, next: Tree): string[] {
  const reasons: string[] = [];
  for (const path of Object.keys(next).sort()) {
    const file = next[path]!;
    if (JSON.stringify(file) === JSON.stringify(old?.[path])) continue;
    if (file.executable || /\.(sh|js|ts|py|mjs|cjs|ps1)$/.test(path))
      reasons.push(`Changed executable/support script: ${path}`);
    const text = Buffer.from(file.data, "base64").toString("utf8");
    if (
      /https?:\/\/|\bsudo\b|\bcurl\b|\bwget\b|\b(install|delete|secret|token|password)\b|ignore (previous|prior)/i.test(
        text,
      )
    )
      reasons.push(`Review network, sensitive actions, or instructions: ${path}`);
  }
  return reasons;
}
