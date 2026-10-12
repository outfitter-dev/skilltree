import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fail, hash } from "./model";
import { atomicJson, readJson, exists, assertNoSymlinks } from "./files";
import { type Context } from "./state";
import { storageRoot } from "./deployment";
import { directoryTree, readLibrarySnapshot, treeDigest, libraryPending } from "./library-backup";
import { inventory, removeOwned } from "./ownership";

const retainedSchema = z
  .object({
    version: z.literal(1),
    collection: z.string(),
    root: z.string(),
    transaction: z.string().uuid(),
    current: hash,
    target: hash,
    pid: z.number().int().positive(),
    finished: z.boolean(),
  })
  .strict();
const tempSchema = z
  .object({
    version: z.literal(1),
    collection: z.string(),
    path: z.string(),
    hash,
    pid: z.number().int().positive(),
    ino: z.number(),
    dev: z.number(),
    size: z.number().int().nonnegative(),
  })
  .strict();
function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function receiptPath(ctx: Context, transaction: string): string {
  return join(ctx.home, "library-retained", z.string().uuid().parse(transaction) + ".json");
}
export function rememberRetained(
  ctx: Context,
  transaction: string,
  current: string,
  target: string,
): void {
  atomicJson(receiptPath(ctx, transaction), {
    version: 1,
    collection: ctx.home,
    root: join(storageRoot(ctx), "library-" + transaction),
    transaction,
    current,
    target,
    pid: process.pid,
    finished: false,
  });
}
export function finishRetained(ctx: Context, transaction: string): void {
  const path = receiptPath(ctx, transaction);
  if (!exists(path)) return; // Legacy directories remain unowned and retained.
  const record = retainedSchema.parse(readJson(path));
  if (
    record.collection !== ctx.home ||
    record.root !== join(storageRoot(ctx), "library-" + transaction)
  )
    fail("OWNERSHIP_HELD", "Retained directory ownership differs");
  atomicJson(path, { ...record, finished: true });
}
export function rememberBlobTemp(home: string, path: string, key: string): void {
  const stat = fs.lstatSync(path);
  atomicJson(join(home, "library-temp-records", path.slice(path.lastIndexOf("/") + 1) + ".json"), {
    version: 1,
    collection: home,
    path,
    hash: key,
    pid: process.pid,
    ino: stat.ino,
    dev: stat.dev,
    size: stat.size,
  });
}
export function forgetBlobTemp(home: string, path: string): void {
  const marker = join(
    home,
    "library-temp-records",
    path.slice(path.lastIndexOf("/") + 1) + ".json",
  );
  if (exists(marker)) fs.unlinkSync(marker);
}
export function compactLibrary(
  ctx: Context,
  options: { retainedDirectories?: boolean; backupScratch?: boolean; dryRun?: boolean },
): {
  candidates: { root: string; kind: string; files: number }[];
  held: { root: string; reason: string }[];
} {
  const candidates: { root: string; kind: string; files: number }[] = [],
    held: { root: string; reason: string }[] = [];
  if (libraryPending(ctx)) fail("RECOVERY_REQUIRED", "Pending directory restore blocks retention");
  const hold = (root: string, error: unknown) =>
    held.push({ root, reason: error instanceof Error ? error.message : "Owned cleanup held" });
  if (options.retainedDirectories) {
    const root = storageRoot(ctx);
    if (exists(root))
      for (const name of fs.readdirSync(root).filter((n) => n.startsWith("library-"))) {
        const path = assertNoSymlinks(join(root, name));
        try {
          const transaction = z.string().uuid().parse(name.slice(8));
          const marker = receiptPath(ctx, transaction),
            record = retainedSchema.parse(readJson(marker));
          if (
            record.collection !== ctx.home ||
            record.root !== path ||
            record.transaction !== transaction ||
            (!record.finished && !exited(record.pid))
          )
            fail("OWNERSHIP_HELD", "Retained transaction owner is live or unrecognized");
          const current = readLibrarySnapshot(ctx, record.current),
            target = readLibrarySnapshot(ctx, record.target);
          if (fs.readdirSync(path).some((n) => !["stage", "prior"].includes(n)))
            fail("OWNERSHIP_HELD", "Unknown retained directory work must survive");
          for (const [name, snapshot] of [
            ["stage", target],
            ["prior", current],
          ] as const) {
            const part = join(path, name);
            if (exists(part) && treeDigest(directoryTree(ctx.home, part)) !== snapshot.hash)
              fail("OWNERSHIP_HELD", `Changed retained directory must survive: ${part}`);
          }
          const files = inventory(path);
          candidates.push({
            root: path,
            kind: "retained-library-directory",
            files: Object.keys(files).length,
          });
          if (!options.dryRun) {
            removeOwned(path, {
              version: 1,
              root: path,
              collection: ctx.home,
              pid: record.pid,
              files,
            });
            fs.rmdirSync(path);
            fs.unlinkSync(marker);
          }
        } catch (error) {
          hold(path, error);
        }
      }
  }
  if (options.backupScratch) {
    const root = join(ctx.home, "library-blobs"),
      records = join(ctx.home, "library-temp-records");
    if (exists(root))
      for (const name of fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))) {
        const path = assertNoSymlinks(join(root, name));
        try {
          if (!/^[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp$/.test(name))
            fail("OWNERSHIP_HELD", "Unknown blob temporary file retained");
          const marker = join(records, name + ".json"),
            record = tempSchema.parse(readJson(marker)),
            stat = fs.lstatSync(path);
          if (
            record.collection !== ctx.home ||
            record.path !== path ||
            dirname(record.path) !== root ||
            !exited(record.pid) ||
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid?.() ||
            stat.gid !== process.getgid?.() ||
            (stat.mode & 0o777) ^ 0o600 ||
            stat.ino !== record.ino ||
            stat.dev !== record.dev ||
            stat.size !== record.size ||
            createHash("sha256").update(fs.readFileSync(path)).digest("hex") !== record.hash
          )
            fail("OWNERSHIP_HELD", "Changed, partial or live-owner blob temp retained");
          candidates.push({ root: path, kind: "verified-blob-temp", files: 1 });
          if (!options.dryRun) {
            fs.unlinkSync(path);
            fs.unlinkSync(marker);
          }
        } catch (error) {
          hold(path, error);
        }
      }
  }
  return { candidates, held };
}
