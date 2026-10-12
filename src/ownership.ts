import * as fs from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hash, fail, type Tree } from "./model";
import { atomicJson, assertNoSymlinks, exists, inside } from "./files";
const ownedPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      p.split("/").every((s) => s && s !== "." && s !== ".."),
  );
export const ownershipSchema = z
  .object({
    version: z.literal(1),
    root: z.string(),
    archive: hash.optional(),
    collection: z.string().optional(),
    pid: z.number().int().positive(),
    files: z.record(
      ownedPath,
      z
        .object({ kind: z.enum(["file", "link", "directory"]), hash: hash, mode: z.number().int() })
        .strict(),
    ),
  })
  .strict();
export type Ownership = z.infer<typeof ownershipSchema>;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function inventory(root: string, exclude: string[] = []): Ownership["files"] {
  assertNoSymlinks(root);
  const files: Ownership["files"] = {};
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const path = join(dir, name),
        rel = relative(root, path);
      if (exclude.includes(rel)) continue;
      const stat = fs.lstatSync(path);
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink())
        fail("OWNERSHIP_HELD", "Special file must be preserved");
      files[rel] = {
        kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file",
        hash: digest(
          stat.isSymbolicLink()
            ? Buffer.from(fs.readlinkSync(path))
            : stat.isFile()
              ? fs.readFileSync(path)
              : Buffer.alloc(0),
        ),
        mode: stat.mode & 0o777,
      };
      if (stat.isDirectory()) walk(path);
    }
  }
  if (exists(root)) walk(root);
  return files;
}
export function materializationRecord(home: string, root: string): string {
  return join(home, "materializations", `${digest(Buffer.from(relative(home, root)))}.json`);
}
export function rememberMaterialization(home: string, root: string, archive: string): void {
  if (!inside(join(home, "repos"), root) && !inside(join(home, "edits"), root))
    fail("UNSAFE_PATH", "Materialization must remain in owned state layout");
  atomicJson(materializationRecord(home, root), {
    version: 1,
    root: relative(home, root),
    archive,
    pid: process.pid,
    files: inventory(root),
  });
}
export function validateOwned(root: string, record: Ownership, exclude: string[] = []): string[] {
  const current = inventory(root, exclude),
    issues: string[] = [];
  for (const [path, actual] of Object.entries(current)) {
    if (JSON.stringify(actual) !== JSON.stringify(record.files[path])) issues.push(path);
  }
  return issues;
}
export function removeOwned(root: string, record: Ownership, exclude: string[] = []): void {
  const issues = validateOwned(root, record, exclude);
  if (issues.length)
    fail("OWNERSHIP_HELD", "Unknown or changed work prevents cache/backup cleanup");
  // Missing generated files are allowed. Recheck each remaining leaf and preserve
  // any concurrent unexpected directory; never use recursive directory removal.
  for (const path of Object.keys(record.files).sort((a, b) => b.length - a.length)) {
    const target = join(root, path);
    if (!exists(target)) continue;
    assertNoSymlinks(join(target, ".."));
    const stat = fs.lstatSync(target);
    const current = {
      kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file",
      hash: digest(
        stat.isSymbolicLink()
          ? Buffer.from(fs.readlinkSync(target))
          : stat.isFile()
            ? fs.readFileSync(target)
            : Buffer.alloc(0),
      ),
      mode: stat.mode & 0o777,
    };
    if (JSON.stringify(current) !== JSON.stringify(record.files[path]))
      fail("OWNERSHIP_HELD", "Owned bytes changed during cleanup");
    if (current!.kind === "directory") fs.rmdirSync(target);
    else fs.unlinkSync(target);
  }
}

export function rememberBackup(root: string, knownTree?: Tree, collection?: string): void {
  const files: Ownership["files"] = {};
  const backup = join(root, "backup");
  if (exists(backup)) {
    for (const [path, record] of Object.entries(inventory(backup))) {
      if (knownTree) {
        if (record.kind === "directory") {
          if (!Object.keys(knownTree).some((key) => key.startsWith(path + "/"))) continue;
        } else {
          const expected = knownTree[path];
          if (
            !expected ||
            record.kind !== "file" ||
            record.hash !== digest(Buffer.from(expected.data, "base64")) ||
            record.mode !== (expected.executable ? 0o755 : 0o644)
          )
            continue;
        }
      }
      files[`backup/${path}`] = record;
    }
    files.backup = {
      kind: "directory",
      hash: digest(Buffer.alloc(0)),
      mode: fs.statSync(backup).mode & 0o777,
    };
  }
  atomicJson(join(root, "owner.json"), { version: 1, root, collection, pid: process.pid, files });
}

export function rememberIntent(home: string, root: string, archive: string): void {
  atomicJson(materializationRecord(home, root), {
    version: 1,
    root: relative(home, root),
    archive,
    pid: process.pid,
    files: {},
  });
}
