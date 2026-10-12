import * as fs from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, fail } from "./model";
import { assertNoSymlinks, exists } from "./files";

const reserveSchema = z
  .object({
    kind: z.literal("reserve"),
    id: z.string().uuid(),
    key: hash,
    pid: z.number().int().positive(),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    markerHash: hash,
    markerSize: z.number().int().positive().max(14000000),
  })
  .strict();
const createdSchema = z
  .object({ kind: z.literal("created"), id: z.string().uuid(), ino: z.number(), dev: z.number() })
  .strict();
const rowSchema = z.union([reserveSchema, createdSchema]);
export type Reservation = z.infer<typeof reserveSchema>;
export interface ScratchJournal {
  reservations: Map<string, Reservation>;
  created: Map<string, { ino: number; dev: number }>;
  held: { root: string; reason: string }[];
}
const MAX_BYTES = 64_000_000;
export const scratchJournalPath = (home: string) =>
  assertNoSymlinks(join(home, "library-scratch.jsonl"));
export function reservationPaths(home: string, row: Reservation) {
  const temp = join(home, "library-blobs", `${row.key}.bin.${row.id}.tmp`);
  return {
    temp,
    marker: join(home, "library-temp-records", basename(temp) + ".json"),
  };
}
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const header = (home: string) => JSON.stringify({ version: 1, collection: home }) + "\n";
function safeJournal(path: string): void {
  const s = fs.lstatSync(path);
  if (
    !s.isFile() ||
    s.nlink !== 1 ||
    s.uid !== process.getuid?.() ||
    s.gid !== process.getgid?.() ||
    (s.mode & 0o7777) !== 0o600 ||
    s.size > MAX_BYTES
  )
    fail(
      "BACKUP_SCRATCH_HELD",
      `Scratch journal identity, permissions or size unsupported: ${path}`,
    );
}
export function readScratchJournal(home: string): ScratchJournal {
  const path = join(home, "library-scratch.jsonl"),
    result: ScratchJournal = { reservations: new Map(), created: new Map(), held: [] };
  try {
    assertNoSymlinks(path);
    if (!exists(path)) return result;
    safeJournal(path);
    const bytes = fs.readFileSync(path, "utf8");
    if (!bytes.startsWith(header(home)))
      fail(
        "BACKUP_SCRATCH_HELD",
        "Incomplete or unrecognized scratch journal header; preserve for inspection",
      );
    const rest = bytes.slice(header(home).length),
      lines = rest.split("\n");
    const tail = lines.pop()!;
    for (const line of lines) {
      try {
        const value = JSON.parse(line),
          { checksum, ...body } = value;
        if (checksum !== digest(JSON.stringify(body))) throw new Error("checksum");
        const row = rowSchema.parse(body);
        if (row.kind === "reserve") {
          if (result.reservations.has(row.id)) throw new Error("duplicate");
          result.reservations.set(row.id, row);
        } else {
          if (!result.reservations.has(row.id) || result.created.has(row.id))
            throw new Error("ownership");
          result.created.set(row.id, { ino: row.ino, dev: row.dev });
        }
      } catch {
        result.held.push({
          root: path,
          reason: "Invalid scratch journal record; later records remain untrusted",
        });
        return result;
      }
    }
    if (tail)
      result.held.push({
        root: path,
        reason:
          "Interrupted scratch journal append; preserve partial tail. No scratch creation follows an unfinished reservation",
      });
  } catch (error) {
    result.held.push({
      root: path,
      reason:
        error instanceof Error
          ? error.message
          : "Scratch journal unreadable; retain for inspection",
    });
  }
  return result;
}
const cache = new Map<
  string,
  { journal: ScratchJournal; size: number; mtime: number; ino: number; dev: number }
>();
export type BlobBoundary =
  | "journal-opened"
  | "reservation-partial"
  | "reservation-written"
  | "creation-partial"
  | "creation-written"
  | "reservation-durable"
  | "intent-opened"
  | "intent-partial"
  | "intent-durable"
  | "temp-created"
  | "created-durable"
  | "payload-written"
  | "blob-published";
export type BoundaryHook = (phase: BlobBoundary, path: string) => void;
function writableJournal(home: string, hook?: BoundaryHook): ScratchJournal {
  const path = scratchJournalPath(home);
  if (!exists(path)) {
    const fd = fs.openSync(path, "wx", 0o600);
    try {
      hook?.("journal-opened", path);
      fs.writeFileSync(fd, header(home));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const parent = fs.openSync(home, "r");
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  }
  safeJournal(path);
  const stat = fs.statSync(path),
    old = cache.get(home);
  if (
    old &&
    old.size === stat.size &&
    old.mtime === stat.mtimeMs &&
    old.ino === stat.ino &&
    old.dev === stat.dev
  )
    return old.journal;
  const journal = readScratchJournal(home);
  if (journal.held.length) fail("BACKUP_SCRATCH_HELD", `${journal.held[0]!.reason}: ${path}`);
  cache.set(home, { journal, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
  return journal;
}
function append(home: string, body: z.infer<typeof rowSchema>, hook?: BoundaryHook): void {
  const journal = writableJournal(home, hook),
    path = scratchJournalPath(home);
  const line = JSON.stringify({ ...body, checksum: digest(JSON.stringify(body)) }) + "\n";
  if (fs.statSync(path).size + Buffer.byteLength(line) > MAX_BYTES)
    fail(
      "BACKUP_LIMIT",
      `Scratch reservation journal reached 64 MB; preserve and review metadata maintenance: ${path}`,
    );
  const fd = fs.openSync(path, "a");
  try {
    if (hook) {
      const mid = Math.floor(line.length / 2);
      fs.writeFileSync(fd, line.slice(0, mid));
      hook(body.kind === "reserve" ? "reservation-partial" : "creation-partial", path);
      fs.writeFileSync(fd, line.slice(mid));
      hook(body.kind === "reserve" ? "reservation-written" : "creation-written", path);
    } else fs.writeFileSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (body.kind === "reserve") journal.reservations.set(body.id, body);
  else journal.created.set(body.id, { ino: body.ino, dev: body.dev });
  const stat = fs.statSync(path);
  cache.set(home, { journal, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
}
export function prepareBlobIntent(
  home: string,
  key: string,
  data: Buffer,
  hook?: BoundaryHook,
): { row: Reservation; temp: string; marker: string } {
  if (digest(data) !== key) fail("STATE_INVALID", "Intended payload identity differs");
  const id = randomUUID(),
    pid = process.pid,
    uid = process.getuid!(),
    gid = process.getgid!();
  const temp = join(home, "library-blobs", `${hash.parse(key)}.bin.${id}.tmp`),
    marker = join(home, "library-temp-records", basename(temp) + ".json");
  const bytes = Buffer.from(
    JSON.stringify({
      version: 3,
      collection: home,
      path: temp,
      hash: key,
      pid,
      size: data.length,
      data: data.toString("base64"),
    }) + "\n",
  );
  const row: Reservation = {
    kind: "reserve",
    id,
    key,
    pid,
    uid,
    gid,
    markerHash: digest(bytes),
    markerSize: bytes.length,
  };
  // The permanent reservation is fsynced before any disposable intent or blob.
  append(home, row, hook);
  hook?.("reservation-durable", temp);
  fs.mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(assertNoSymlinks(marker), "wx", 0o600);
  try {
    hook?.("intent-opened", marker);
    if (hook) {
      const mid = Math.floor(bytes.length / 2);
      fs.writeFileSync(fd, bytes.subarray(0, mid));
      hook("intent-partial", marker);
      fs.writeFileSync(fd, bytes.subarray(mid));
    } else fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parent = fs.openSync(dirname(marker), "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
  hook?.("intent-durable", marker);
  return { row, temp, marker };
}
export function checkpointBlobCreation(
  home: string,
  row: Reservation,
  fd: number,
  hook?: BoundaryHook,
): void {
  const stat = fs.fstatSync(fd);
  append(home, { kind: "created", id: row.id, ino: stat.ino, dev: stat.dev }, hook);
}
