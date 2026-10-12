import { reservedScratch } from "./reserved-scratch";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fail, hash } from "./model";
import { atomicJson, readJson, exists, assertNoSymlinks } from "./files";
import { type Context } from "./state";
import { storageRoot } from "./deployment";
import { directoryTree, readLibrarySnapshot, treeDigest, libraryPending } from "./library-backup";
import { checkMetadata } from "./filesystem-capabilities";
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
    version: z.union([z.literal(1), z.literal(2)]),
    collection: z.string(),
    path: z.string(),
    hash,
    pid: z.number().int().positive(),
    ino: z.number(),
    dev: z.number(),
    size: z.number().int().nonnegative(),
    data: z.string().optional(),
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
export function rememberBlobTemp(
  home: string,
  path: string,
  key: string,
  intended: Buffer = fs.readFileSync(path),
): void {
  const stat = fs.lstatSync(path),
    records = join(home, "library-temp-records");
  if (createHash("sha256").update(intended).digest("hex") !== key)
    fail("STATE_INVALID", "Temp intent payload does not match its blob identity");
  fs.mkdirSync(records, { recursive: true, mode: 0o700 });
  const parent = fs.openSync(home, "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
  const marker = assertNoSymlinks(join(records, path.slice(path.lastIndexOf("/") + 1) + ".json"));
  const fd = fs.openSync(marker, "wx", 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        version: 2,
        collection: home,
        path,
        hash: key,
        pid: process.pid,
        ino: stat.ino,
        dev: stat.dev,
        size: intended.length,
        data: intended.toString("base64"),
      }) + "\n",
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // A complete durable intent must exist before the payload is written. Avoid
  // atomicJson receipt temps, which themselves lacked crash ownership evidence.
  const dir = fs.openSync(records, "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
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
  if (!options.dryRun && libraryPending(ctx))
    fail("RECOVERY_REQUIRED", "Pending directory restore blocks retention");
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
    const reserved = reservedScratch(ctx.home, !!options.dryRun);
    candidates.push(...reserved.candidates);
    held.push(...reserved.held);
    const root = join(ctx.home, "library-blobs"),
      records = join(ctx.home, "library-temp-records"),
      seen = new Set<string>();
    const clean = (name: string) => {
      if (reserved.claimed.has(name)) {
        seen.add(name + ".json");
        return;
      }
      const path = assertNoSymlinks(join(root, name)),
        marker = join(records, name + ".json");
      seen.add(name + ".json");
      try {
        if (!/^[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp$/.test(name))
          fail("OWNERSHIP_HELD", "Unknown blob temporary file retained");
        if (!exists(marker))
          fail(
            "OWNERSHIP_HELD",
            "No complete ownership intent; temporary blob retained for inspection",
          );
        const markerStat = fs.lstatSync(assertNoSymlinks(marker));
        if (
          !markerStat.isFile() ||
          markerStat.nlink !== 1 ||
          markerStat.uid !== process.getuid?.() ||
          markerStat.gid !== process.getgid?.() ||
          (markerStat.mode & 0o777) !== 0o600 ||
          markerStat.size > 14000000
        )
          fail(
            "OWNERSHIP_HELD",
            "Temporary intent identity or permissions are unsupported; retained",
          );
        let record: z.infer<typeof tempSchema>;
        try {
          record = tempSchema.parse(readJson(marker));
        } catch {
          fail(
            "OWNERSHIP_HELD",
            "Incomplete or invalid temporary ownership intent retained for inspection",
          );
        }
        if (
          record!.hash !== name.slice(0, 64) ||
          record!.collection !== ctx.home ||
          record!.path !== path ||
          dirname(record!.path) !== root ||
          !exited(record!.pid)
        )
          fail("OWNERSHIP_HELD", "Temporary intent belongs to a live or unrecognized owner");
        let expected: Buffer | null = null;
        if (record!.version === 2) {
          if (record!.data === undefined)
            fail("OWNERSHIP_HELD", "Incomplete intended payload retained");
          expected = Buffer.from(record!.data!, "base64");
          if (
            expected.toString("base64") !== record!.data ||
            expected.length !== record!.size ||
            createHash("sha256").update(expected).digest("hex") !== record!.hash
          )
            fail("OWNERSHIP_HELD", "Corrupt intended payload retained");
        } else if (record!.data !== undefined)
          fail("OWNERSHIP_HELD", "Unrecognized legacy intent retained");
        if (exists(path)) {
          const stat = fs.lstatSync(path);
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== process.getuid?.() ||
            stat.gid !== process.getgid?.() ||
            (stat.mode & 0o777) !== 0o600 ||
            stat.ino !== record!.ino ||
            stat.dev !== record!.dev
          )
            fail("OWNERSHIP_HELD", "Temporary blob identity or permissions changed; retained");
          if (stat.size > record!.size)
            fail("OWNERSHIP_HELD", "Temporary size exceeds intended payload; retained");
          const actual = fs.readFileSync(path);
          if (
            expected
              ? actual.length > expected.length ||
                !actual.equals(expected.subarray(0, actual.length))
              : stat.size !== record!.size ||
                createHash("sha256").update(actual).digest("hex") !== record!.hash
          )
            fail("OWNERSHIP_HELD", "Temporary bytes differ from the recorded payload; retained");
          checkMetadata(path, [path]);
          candidates.push({ root: path, kind: "verified-blob-temp", files: 1 });
          if (!options.dryRun) fs.unlinkSync(path);
        } else {
          const published = assertNoSymlinks(join(root, record!.hash + ".bin"));
          if (
            !exists(published) ||
            !fs.lstatSync(published).isFile() ||
            fs.lstatSync(published).size !== record!.size ||
            createHash("sha256").update(fs.readFileSync(published)).digest("hex") !== record!.hash
          )
            fail(
              "OWNERSHIP_HELD",
              "Temp absent without a verified published blob; intent retained",
            );
          candidates.push({ root: marker, kind: "completed-blob-intent", files: 1 });
        }
        if (!options.dryRun) fs.unlinkSync(marker);
      } catch (error) {
        hold(path, error);
      }
    };
    if (exists(root))
      for (const name of fs.readdirSync(root).filter((n) => n.endsWith(".tmp"))) clean(name);
    if (exists(records))
      for (const name of fs.readdirSync(records)) {
        if (seen.has(name) || reserved.claimed.has(name)) continue;
        if (/^[a-f0-9]{64}\.bin\.[a-f0-9-]{36}\.tmp\.json$/.test(name)) clean(name.slice(0, -5));
        else
          hold(
            join(records, name),
            new Error("Legacy or incomplete ownership-record artifact retained for inspection"),
          );
      }
  }
  return { candidates, held };
}
