import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync, inflateSync } from "node:zlib";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, slug, fail, type Source, type Entry } from "./model";
import { atomicJson, readJson, assertNoSymlinks, exists, treeHash, getObject } from "./files";
import {
  git,
  gitBytes,
  sourcePath,
  localPath,
  preflightSource,
  preflightLocal,
  committedTree,
} from "./git";
import { save, type Context } from "./state";

const fields = {
  kind: z.enum(["source", "local"]),
  id: slug,
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  repository: z.string().nullable(),
};
const objectSchema = z
  .object({
    type: z.enum(["commit", "tree", "blob", "tag"]),
    data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
const archiveSchema = z.discriminatedUnion("version", [
  z
    .object({ version: z.literal(1), ...fields, data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/) })
    .strict(),
  z
    .object({
      version: z.literal(2),
      ...fields,
      objects: z.record(z.string().regex(/^[a-f0-9]{40,64}$/), hash),
    })
    .strict(),
]);
type Archive = z.infer<typeof archiveSchema>;
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function rawObject(value: z.infer<typeof objectSchema>): Buffer {
  const bytes = Buffer.from(value.data, "base64");
  return Buffer.concat([Buffer.from(`${value.type} ${bytes.length}\0`), bytes]);
}
function objectId(raw: Buffer, oid: string): string {
  return createHash(oid.length === 64 ? "sha256" : "sha1")
    .update(raw)
    .digest("hex");
}
export function archiveRepository(
  home: string,
  root: string,
  kind: Archive["kind"],
  id: string,
  revision: string,
  repository: string | null,
): string {
  // Store each Git object once. Archive manifests retain revisions/history without
  // writing another full bundle or checkout for every changed revision.
  const bytes = gitBytes(root, ["cat-file", "--batch-all-objects", "--batch"]);
  const objects: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) fail("ARCHIVE_CORRUPT", "Invalid Git object stream");
    const [oid, type, sizeText] = bytes.subarray(offset, end).toString().split(" ");
    const size = Number(sizeText);
    offset = end + 1;
    if (!oid || !Number.isSafeInteger(size) || size < 0 || offset + size >= bytes.length)
      fail("ARCHIVE_CORRUPT", "Invalid Git object length");
    const value = objectSchema.parse({
      type,
      data: bytes.subarray(offset, offset + size).toString("base64"),
    });
    if (objectId(rawObject(value), oid) !== oid)
      fail("ARCHIVE_CORRUPT", "Git object identity mismatch");
    const key = digest(value);
    const path = join(home, "archive-objects", `${key}.json`);
    if (exists(path)) {
      if (digest(objectSchema.parse(readJson(path))) !== key)
        fail("ARCHIVE_CORRUPT", "Existing archive object corrupt");
    } else atomicJson(path, value);
    objects[oid] = key;
    offset += size + 1;
  }
  const value = archiveSchema.parse({ version: 2, kind, id, revision, repository, objects });
  const key = digest(value);
  const path = join(home, "archives", `${key}.json`);
  if (exists(path)) readArchive(home, key);
  else atomicJson(path, value);
  return key;
}
function readArchive(home: string, key: string): Archive {
  hash.parse(key);
  const path = assertNoSymlinks(join(home, "archives", `${key}.json`));
  if (!exists(path))
    fail("ARCHIVE_MISSING", "Verified durable archive unavailable; no network fallback");
  const value = archiveSchema.parse(readJson(path));
  if (digest(value) !== key) fail("ARCHIVE_CORRUPT", "Archive digest mismatch");
  if (value.version === 2)
    for (const [oid, ref] of Object.entries(value.objects)) {
      const object = objectSchema.parse(readJson(join(home, "archive-objects", `${ref}.json`)));
      if (digest(object) !== ref || objectId(rawObject(object), oid) !== oid)
        fail("ARCHIVE_CORRUPT", "Archive object digest/provenance mismatch");
    }
  return value;
}
export function materialize(
  home: string,
  key: string,
  kind: Archive["kind"],
  id: string,
  revision: string,
  repository: string | null,
  root: string,
): void {
  const value = readArchive(home, key);
  if (
    value.kind !== kind ||
    value.id !== id ||
    value.revision !== revision ||
    value.repository !== repository
  )
    fail("ARCHIVE_MISMATCH", "Archive differs from accepted provenance");
  assertNoSymlinks(root);
  fs.mkdirSync(root);
  git(root, [
    "init",
    "-b",
    "skilltree-local",
    ...(revision.length === 64 ? ["--object-format=sha256"] : []),
  ]);
  if (value.version === 1) {
    const temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skilltree-materialize-")));
    try {
      const bundle = join(temp, "history.bundle");
      fs.writeFileSync(bundle, Buffer.from(value.data, "base64"), { flag: "wx" });
      git(root, ["bundle", "verify", bundle]);
      git(root, ["fetch", bundle, revision]);
    } finally {
      fs.rmSync(temp, { recursive: true });
    }
  } else {
    for (const [oid, ref] of Object.entries(value.objects)) {
      const object = objectSchema.parse(readJson(join(home, "archive-objects", `${ref}.json`)));
      const raw = rawObject(object);
      const shared = assertNoSymlinks(join(home, "git-objects", oid));
      fs.mkdirSync(dirname(shared), { recursive: true });
      if (exists(shared)) {
        if (!inflateSync(fs.readFileSync(shared)).equals(raw))
          fail("ARCHIVE_CORRUPT", "Shared Git cache differs from immutable object");
      } else fs.writeFileSync(shared, deflateSync(raw), { flag: "wx", mode: 0o444 });
      const target = join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.linkSync(shared, target);
    }
    git(root, ["fsck", "--no-reflogs", "--no-dangling", revision]);
  }
  git(root, ["checkout", "--detach", revision]);
  if (repository) git(root, ["remote", "add", "origin", repository]);
  else git(root, ["checkout", "-B", "skilltree-local", revision]);
}
// Retire only exact generated tracked bytes after state publication. Durable
// objects/history remain archived; unknown files and all Git metadata are retained.
export function retireSource(home: string, source: Source): void {
  const root = sourcePath(home, source);
  try {
    preflightSource(root, source.repository, source.revision);
  } catch {
    return;
  }
  const parents = new Set<string>();
  for (const row of gitBytes(root, ["ls-tree", "-r", "-z", source.revision])
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const split = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, split).split(" ");
    const path = row.slice(split + 1);
    if (
      split < 0 ||
      type !== "blob" ||
      !["100644", "100755", "120000"].includes(mode!) ||
      path.split("/").some((p) => p === ".." || p === ".git")
    )
      continue;
    const target = join(root, path);
    const stat = fs.lstatSync(target);
    const expected = gitBytes(root, ["cat-file", "blob", oid!]);
    const actual = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(target))
      : stat.isFile()
        ? fs.readFileSync(target)
        : null;
    if (
      !actual?.equals(expected) ||
      (mode !== "120000" && ((stat.mode & 0o111) !== 0) !== (mode === "100755"))
    )
      continue;
    fs.unlinkSync(target);
    for (let parent = dirname(target); parent !== root; parent = dirname(parent))
      parents.add(parent);
  }
  for (const dir of [...parents].sort((a, b) => b.length - a.length))
    try {
      fs.rmdirSync(dir);
    } catch {
      /* Unknown files are retained. */
    }
}
// Explicit restoration permits missing generated files, never modified/unknown work.
function restorable(root: string, revision: string): void {
  assertNoSymlinks(root);
  if (!exists(root)) return;
  assertNoSymlinks(join(root, ".git"));
  if (git(root, ["rev-parse", "HEAD"]) !== revision)
    fail("RESTORE_HELD", "Retain checkout with unaccepted history; reconcile before restore");
  const flags = gitBytes(root, ["ls-files", "-v", "-z"]).toString().split("\0");
  if (flags.some((line) => line && (line[0] === "S" || /[a-z]/.test(line[0]!))))
    fail("RESTORE_HELD", "Index flags may conceal work; preserve and reconcile it");
  const rows = gitBytes(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored",
  ])
    .toString()
    .split("\0")
    .filter(Boolean);
  if (rows.some((row) => row.slice(0, 2) !== " D"))
    fail(
      "RESTORE_HELD",
      "Modified, staged or unknown checkout work must be reconciled before restore",
    );
}
export function restoreMaterializations(ctx: Context, dryRun: boolean): unknown {
  const sources: Source[] = [];
  const entries: Entry[] = [];
  const retained: string[] = [];
  // Validate every archive and old checkout before creating any materialization.
  for (const source of ctx.lock.sources) {
    if (!source.archive)
      fail(
        "ARCHIVE_MISSING",
        "Legacy source has no archive; run archive while its checkout is intact",
      );
    const value = readArchive(ctx.home, source.archive);
    if (
      value.kind !== "source" ||
      value.id !== source.id ||
      value.revision !== source.revision ||
      value.repository !== source.repository
    )
      fail("ARCHIVE_MISMATCH", "Source archive differs from accepted provenance");
    restorable(sourcePath(ctx.home, source), source.revision);
  }
  for (const entry of ctx.lock.entries)
    if (entry.local) {
      if (!entry.local.archive)
        fail("ARCHIVE_MISSING", "Legacy local history has no archive; run archive while intact");
      const value = readArchive(ctx.home, entry.local.archive);
      if (
        value.kind !== "local" ||
        value.id !== entry.id ||
        value.revision !== entry.local.commit ||
        value.repository !== null
      )
        fail("ARCHIVE_MISMATCH", "Local archive differs from accepted provenance");
      restorable(localPath(ctx.home, entry.id, entry.local), entry.local.commit);
      getObject(ctx.home, entry.local.hash);
    }
  if (dryRun)
    return {
      outcome: "WOULD_RESTORE",
      sources: ctx.lock.sources.length,
      histories: ctx.lock.entries.filter((e) => e.local).length,
    };
  fs.mkdirSync(join(ctx.home, "repos"), { recursive: true });
  fs.mkdirSync(join(ctx.home, "edits"), { recursive: true });
  for (const source of ctx.lock.sources) {
    const next = { ...source, checkout: randomUUID() };
    const root = sourcePath(ctx.home, next);
    materialize(
      ctx.home,
      source.archive!,
      "source",
      source.id,
      source.revision,
      source.repository,
      root,
    );
    preflightSource(root, source.repository, source.revision);
    sources.push(next);
    retained.push(sourcePath(ctx.home, source));
  }
  for (const entry of ctx.lock.entries) {
    if (!entry.local) {
      entries.push(entry);
      continue;
    }
    const local = { ...entry.local, checkout: randomUUID() };
    const root = localPath(ctx.home, entry.id, local);
    materialize(ctx.home, local.archive!, "local", entry.id, local.commit, null, root);
    if (treeHash(committedTree(root, local.commit)) !== local.hash)
      fail("ARCHIVE_MISMATCH", "Restored local commit differs from approved content");
    preflightLocal(ctx.home, entry.id, local);
    entries.push({ ...entry, local });
    retained.push(localPath(ctx.home, entry.id, entry.local));
  }
  ctx.lock.sources = sources;
  ctx.lock.entries = entries;
  save(ctx);
  return {
    outcome: "RESTORED",
    retained,
    sources: sources.length,
    histories: entries.filter((e) => e.local).length,
  };
}
export function archiveAccepted(ctx: Context, dryRun: boolean): unknown {
  for (const source of ctx.lock.sources)
    preflightSource(sourcePath(ctx.home, source), source.repository, source.revision);
  for (const entry of ctx.lock.entries) preflightLocal(ctx.home, entry.id, entry.local);
  if (!dryRun) {
    ctx.lock.sources = ctx.lock.sources.map((source) => ({
      ...source,
      archive: archiveRepository(
        ctx.home,
        sourcePath(ctx.home, source),
        "source",
        source.id,
        source.revision,
        source.repository,
      ),
    }));
    ctx.lock.entries = ctx.lock.entries.map((entry) =>
      entry.local
        ? {
            ...entry,
            local: {
              ...entry.local,
              archive: archiveRepository(
                ctx.home,
                localPath(ctx.home, entry.id, entry.local),
                "local",
                entry.id,
                entry.local.commit,
                null,
              ),
            },
          }
        : entry,
    );
    save(ctx);
  }
  return { outcome: dryRun ? "WOULD_ARCHIVE" : "ARCHIVED" };
}
