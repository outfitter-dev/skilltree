import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { hash, fail } from "./model";
import { exists, assertNoSymlinks } from "./files";
import { checkMetadata } from "./filesystem-capabilities";
import { readScratchJournal, reservationPaths } from "./scratch-journal";
const markerSchema = z
  .object({
    version: z.literal(3),
    collection: z.string(),
    path: z.string(),
    hash,
    pid: z.number().int().positive(),
    size: z.number().int().nonnegative(),
    data: z.string(),
  })
  .strict();
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function safeFile(path: string, uid: number, gid: number): fs.Stats {
  assertNoSymlinks(path);
  const stat = fs.lstatSync(path);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o7777) !== 0o600
  )
    fail(
      "OWNERSHIP_HELD",
      "Reserved scratch identity or permissions changed; retain for inspection",
    );
  checkMetadata(path, [path]);
  return stat;
}
export function reservedScratch(
  home: string,
  dryRun: boolean,
): {
  claimed: Set<string>;
  candidates: { root: string; kind: string; files: number }[];
  held: { root: string; reason: string }[];
} {
  const journal = readScratchJournal(home),
    claimed = new Set<string>(),
    candidates: { root: string; kind: string; files: number }[] = [],
    held = [...journal.held];
  for (const row of journal.reservations.values()) {
    const { temp, marker } = reservationPaths(home, row);
    claimed.add(basename(temp));
    claimed.add(basename(marker));
    if (!exists(temp) && !exists(marker)) continue; // A reserved operation may never have started.
    try {
      if (row.uid !== process.getuid?.() || row.gid !== process.getgid?.() || !exited(row.pid))
        fail("OWNERSHIP_HELD", "Reserved scratch owner is live or belongs to another operator");
      let expected: Buffer | null = null;
      if (exists(marker)) {
        const stat = safeFile(marker, row.uid, row.gid);
        if (stat.size > row.markerSize)
          fail("OWNERSHIP_HELD", "Reserved intent size changed; preserve unknown bytes");
        if (stat.size) {
          const raw = fs.readFileSync(marker);
          if (raw.length !== row.markerSize || digest(raw) !== row.markerHash)
            fail(
              "OWNERSHIP_HELD",
              "Interrupted or changed intent bytes retained; no payload creation follows an unfinished intent",
            );
          const value = markerSchema.parse(JSON.parse(raw.toString()));
          expected = Buffer.from(value.data, "base64");
          if (
            value.collection !== home ||
            value.path !== temp ||
            value.hash !== row.key ||
            value.pid !== row.pid ||
            value.data !== expected.toString("base64") ||
            value.size !== expected.length ||
            digest(expected) !== row.key
          )
            fail("OWNERSHIP_HELD", "Reserved intent contents differ; retain for inspection");
        }
      }
      if (exists(temp)) {
        const stat = safeFile(temp, row.uid, row.gid),
          created = journal.created.get(row.id);
        if (created && (stat.ino !== created.ino || stat.dev !== created.dev))
          fail("OWNERSHIP_HELD", "Reserved blob inode changed; retain for inspection");
        if (stat.size) {
          if (!created)
            fail(
              "OWNERSHIP_HELD",
              "Nonempty blob lacks a durable creation checkpoint; preserve unknown data",
            );
          if (expected) {
            if (
              stat.size > expected.length ||
              !fs.readFileSync(temp).equals(expected.subarray(0, stat.size))
            )
              fail("OWNERSHIP_HELD", "Reserved payload bytes changed; retain for inspection");
          } else if (stat.size > 10000000 || digest(fs.readFileSync(temp)) !== row.key)
            fail(
              "OWNERSHIP_HELD",
              "Blob without complete intent cannot prove its payload; retain for inspection",
            );
        }
        // Empty files have no unknown payload; the durable reservation predates creation.
      }
      candidates.push({
        root: exists(temp) ? temp : marker,
        kind: "reserved-backup-scratch",
        files: Number(exists(temp)) + Number(exists(marker)),
      });
      if (!dryRun) {
        if (exists(temp)) fs.unlinkSync(temp);
        if (exists(marker)) fs.unlinkSync(marker);
      }
    } catch (e) {
      held.push({
        root: exists(temp) ? temp : marker,
        reason: e instanceof Error ? e.message : "Reserved scratch changed; retain for inspection",
      });
    }
  }
  return { claimed, candidates, held };
}
