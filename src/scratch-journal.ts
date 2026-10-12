import * as fs from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, fail } from "./model";
import { assertNoSymlinks, exists, storageWrite } from "./files";

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
const sealedSchema = z
  .object({ kind: z.literal("sealed"), key: hash, id: z.string().uuid(), reason: z.string() })
  .strict();
const rowSchema = z.union([reserveSchema, createdSchema, sealedSchema]);
export type Reservation = z.infer<typeof reserveSchema>;
export interface ScratchJournal {
  reservations: Map<string, Reservation>;
  created: Map<string, { ino: number; dev: number }>;
  held: { root: string; reason: string }[];
  preserved: { root: string; reason: string }[];
  sealed: z.infer<typeof sealedSchema>[];
  capacity: { bytes: number; remaining: number; usable: boolean; warning: boolean };
}
export const MAX_SCRATCH_BYTES = 64_000_000;
const MAX_BYTES = MAX_SCRATCH_BYTES;
export const MIN_SCRATCH_CYCLE = 2048;
export const scratchSealPath = (home: string, key: string, id: string) =>
  assertNoSymlinks(
    join(home, "library-scratch-seals", `${hash.parse(key)}.${z.string().uuid().parse(id)}.jsonl`),
  );
export const scratchRepairPending = (home: string) =>
  exists(join(home, "library-scratch-repair.json"));
export const scratchHeader = (home: string) =>
  JSON.stringify({ version: 1, collection: home }) + "\n";
export const scratchLine = (body: unknown) =>
  JSON.stringify({
    ...(body as object),
    checksum: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  }) + "\n";
export function clearScratchCache(home: string): void {
  cache.delete(home);
}
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
const header = scratchHeader;
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
    result: ScratchJournal = {
      reservations: new Map(),
      created: new Map(),
      held: [],
      preserved: [],
      sealed: [],
      capacity: { bytes: 0, remaining: MAX_BYTES, usable: true, warning: false },
    };
  try {
    assertNoSymlinks(path);
    if (!exists(path)) return result;
    const size = fs.lstatSync(path).size;
    result.capacity = {
      bytes: size,
      remaining: MAX_BYTES - size,
      usable: MAX_BYTES - size >= MIN_SCRATCH_CYCLE,
      warning: MAX_BYTES - size <= 1000000,
    };
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
        } else if (row.kind === "sealed") {
          const sealed = scratchSealPath(home, row.key, row.id);
          const stat = fs.lstatSync(sealed);
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o7777) !== 0o600 ||
            digest(fs.readFileSync(sealed)) !== row.key
          )
            throw new Error("seal");
          result.sealed.push(row);
          result.preserved.push({ root: sealed, reason: row.reason });
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
          "Interrupted scratch journal append; preserve bytes. A partial creation checkpoint may follow existing empty scratch. Use recover --scratch --dry-run",
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
  if (scratchRepairPending(home))
    fail("RECOVERY_REQUIRED", "Scratch journal repair is pending; run recover --scratch");
  if (!exists(path)) {
    const fd = storageWrite(path, () => fs.openSync(path, "wx", 0o600));
    try {
      hook?.("journal-opened", path);
      storageWrite(path, () => {
        fs.writeFileSync(fd, header(home));
        fs.fsyncSync(fd);
      });
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
  ) {
    if (old.journal.held.length) fail("BACKUP_SCRATCH_HELD", old.journal.held[0]!.reason);
    return old.journal;
  }
  const journal = readScratchJournal(home);
  if (journal.held.length) fail("BACKUP_SCRATCH_HELD", `${journal.held[0]!.reason}: ${path}`);
  cache.set(home, { journal, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
  return journal;
}
function append(home: string, body: z.infer<typeof rowSchema>, hook?: BoundaryHook): void {
  const journal = writableJournal(home, hook),
    path = scratchJournalPath(home);
  const line = scratchLine(body);
  if (fs.statSync(path).size + Buffer.byteLength(line) > MAX_BYTES)
    fail(
      "BACKUP_LIMIT",
      `Scratch reservation journal reached 64 MB; preserve and review metadata maintenance: ${path}`,
    );
  const fd = storageWrite(path, () => fs.openSync(path, "a"));
  try {
    storageWrite(path, () => {
      if (hook) {
        const mid = Math.floor(line.length / 2);
        fs.writeFileSync(fd, line.slice(0, mid));
        hook(body.kind === "reserve" ? "reservation-partial" : "creation-partial", path);
        fs.writeFileSync(fd, line.slice(mid));
        hook(body.kind === "reserve" ? "reservation-written" : "creation-written", path);
      } else fs.writeFileSync(fd, line);
      fs.fsyncSync(fd);
    });
  } finally {
    fs.closeSync(fd);
  }
  if (body.kind === "reserve") journal.reservations.set(body.id, body);
  else if (body.kind === "created") journal.created.set(body.id, { ino: body.ino, dev: body.dev });
  const stat = fs.statSync(path);
  journal.capacity = {
    bytes: stat.size,
    remaining: MAX_BYTES - stat.size,
    usable: MAX_BYTES - stat.size >= MIN_SCRATCH_CYCLE,
    warning: MAX_BYTES - stat.size <= 1000000,
  };
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
  writableJournal(home, hook);
  const needed = Math.max(MIN_SCRATCH_CYCLE, Buffer.byteLength(scratchLine(row)) + 512);
  if (fs.statSync(scratchJournalPath(home)).size + needed > MAX_BYTES)
    fail(
      "BACKUP_LIMIT",
      `Scratch journal cannot fit reservation and creation checkpoint: ${scratchJournalPath(home)}; use recover --scratch --dry-run`,
    );
  // The permanent reservation is fsynced before any disposable intent or blob.
  append(home, row, hook);
  hook?.("reservation-durable", temp);
  fs.mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  const fd = storageWrite(marker, () => fs.openSync(assertNoSymlinks(marker), "wx", 0o600));
  try {
    hook?.("intent-opened", marker);
    storageWrite(marker, () => {
      if (hook) {
        const mid = Math.floor(bytes.length / 2);
        fs.writeFileSync(fd, bytes.subarray(0, mid));
        hook("intent-partial", marker);
        fs.writeFileSync(fd, bytes.subarray(mid));
      } else fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    });
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
