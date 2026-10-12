import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, fail } from "./model";
import { assertNoSymlinks, exists, readJson, atomicJson, storageWrite } from "./files";
import { type Context } from "./state";
import {
  readScratchJournal,
  reservationPaths,
  scratchJournalPath,
  scratchSealPath,
  scratchHeader,
  scratchLine,
  clearScratchCache,
} from "./scratch-journal";
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const planSchema = z
  .object({
    version: z.literal(1),
    collection: z.string(),
    id: z.string().uuid(),
    old: hash,
    next: hash,
    data: z.string(),
  })
  .strict();
const planPath = (home: string) => join(home, "library-scratch-repair.json");
function safe(path: string): void {
  assertNoSymlinks(path);
  const s = fs.lstatSync(path);
  if (
    !s.isFile() ||
    s.nlink !== 1 ||
    s.uid !== process.getuid?.() ||
    s.gid !== process.getgid?.() ||
    (s.mode & 0o7777) !== 0o600 ||
    s.size > 256000000
  )
    fail(
      "SCRATCH_REPAIR_HELD",
      `Scratch repair requires a readable same-owner regular file: ${path}`,
    );
}
function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function knownOwners(data: string, home: string): number[] {
  const owners = new Set<number>();
  for (const line of data.split("\n").slice(1).filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.kind !== "reserve") continue;
    const p = reservationPaths(home, row);
    if ((exists(p.temp) || exists(p.marker)) && !exited(row.pid)) owners.add(row.pid);
  }
  const records = join(home, "library-temp-records");
  if (exists(records))
    for (const name of fs.readdirSync(records)) {
      const path = join(records, name);
      const stat = fs.lstatSync(path);
      if (!stat.isFile() || stat.size > 14000000) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path, "utf8"));
        if (
          record.collection === home &&
          Number.isSafeInteger(record.pid) &&
          record.pid > 0 &&
          !exited(record.pid)
        )
          owners.add(record.pid);
      } catch {
        /* Unknown artifacts remain untouched. */
      }
    }
  return [...owners];
}
function nextContents(
  ctx: Context,
  id: string,
  old: string,
): { data: string; owners: number[]; carried: number; preserved: number } {
  const journal = readScratchJournal(ctx.home),
    rows: object[] = [],
    owners = new Set<number>();
  let carried = 0;
  for (const row of journal.reservations.values()) {
    const p = reservationPaths(ctx.home, row);
    if (!exists(p.temp) && !exists(p.marker)) continue;
    if (!exited(row.pid)) owners.add(row.pid);
    rows.push(row);
    const created = journal.created.get(row.id);
    if (created) rows.push({ kind: "created", id: row.id, ...created });
    carried++;
  }
  // Unknown artifacts are left in place. Their original journal bytes remain in the seal.
  const reason = journal.held.length
    ? "Reviewed seal preserves interrupted/untrusted journal bytes; unknown scratch remains unowned"
    : "Reviewed capacity rollover preserves the original journal";
  rows.push(...journal.sealed, { kind: "sealed", key: old, id, reason });
  return {
    data: scratchHeader(ctx.home) + rows.map(scratchLine).join(""),
    owners: [...owners],
    carried,
    preserved: journal.sealed.length + 1,
  };
}
export type RepairBoundary = (phase: "prepared" | "sealed" | "installed") => void;
export function recoverScratch(
  ctx: Context,
  dryRun: boolean,
  expected?: string,
  hook?: RepairBoundary,
): unknown {
  const active = scratchJournalPath(ctx.home),
    intent = planPath(ctx.home);
  let plan: z.infer<typeof planSchema>;
  if (exists(intent)) {
    safe(intent);
    plan = planSchema.parse(readJson(intent));
    if (plan.collection !== ctx.home || digest(plan.data) !== plan.next)
      fail(
        "SCRATCH_REPAIR_HELD",
        "Scratch repair intent identity differs; preserve for inspection",
      );
    if (expected && hash.parse(expected) !== plan.old)
      fail("SCRATCH_REPAIR_STALE", "Reviewed journal identity differs from pending repair");
    if (dryRun)
      return {
        outcome: "WOULD_RESUME_SCRATCH",
        expected: plan.old,
        sealed: scratchSealPath(ctx.home, plan.old, plan.id),
      };
  } else {
    if (!exists(active)) return { outcome: "CURRENT", message: "No scratch journal exists" };
    safe(active);
    const old = digest(fs.readFileSync(active)),
      id = randomUUID(),
      next = nextContents(ctx, id, old);
    if (expected && hash.parse(expected) !== old)
      fail("SCRATCH_REPAIR_STALE", "Scratch journal changed after review");
    if (next.owners.length || knownOwners(next.data, ctx.home).length)
      fail(
        "SCRATCH_OWNER_ACTIVE",
        "A recognized scratch owner is live or cannot be proved exited; stop it before journal repair",
      );
    if (dryRun)
      return {
        outcome: "WOULD_SEAL_SCRATCH",
        expected: old,
        carried: next.carried,
        preservedJournals: next.preserved,
        unknownArtifacts: "retained in place; never adopted or deleted",
        message: "Real repair acquires the collection lock and refuses active recognized owners",
      };
    if (!expected)
      fail("USAGE", "Scratch repair requires --expect from recover --scratch --dry-run");
    plan = { version: 1, collection: ctx.home, id, old, next: digest(next.data), data: next.data };
    atomicJson(intent, plan);
  }
  const live = knownOwners(plan.data, ctx.home);
  if (live.length)
    fail("SCRATCH_OWNER_ACTIVE", "Recognized scratch owner is active; preserve repair intent");
  const sealed = scratchSealPath(ctx.home, plan.old, plan.id),
    stage = assertNoSymlinks(join(dirname(sealed), plan.id + ".next"));
  fs.mkdirSync(dirname(sealed), { recursive: true, mode: 0o700 });
  if (exists(active) && digest(fs.readFileSync(active)) === plan.next) {
    if (!exists(sealed) || digest(fs.readFileSync(sealed)) !== plan.old)
      fail("SCRATCH_REPAIR_HELD", "Installed scratch journal lacks its intact original seal");
    fs.unlinkSync(intent);
    clearScratchCache(ctx.home);
    return { outcome: "SCRATCH_RECOVERED", sealed, preserved: true };
  }
  if (exists(active) && digest(fs.readFileSync(active)) !== plan.old)
    fail("SCRATCH_REPAIR_STALE", "Unknown/newer active journal must be retained");
  if (exists(stage)) {
    safe(stage);
    const actual = fs.readFileSync(stage),
      bytes = Buffer.from(plan.data);
    if (actual.length > bytes.length || !actual.equals(bytes.subarray(0, actual.length)))
      fail("SCRATCH_REPAIR_HELD", "Replacement journal contains unknown bytes; preserve it");
    const fd = storageWrite(stage, () => fs.openSync(stage, "a"));
    try {
      storageWrite(stage, () => {
        fs.writeFileSync(fd, bytes.subarray(actual.length));
        fs.fsyncSync(fd);
      });
    } finally {
      fs.closeSync(fd);
    }
  } else {
    const fd = storageWrite(stage, () => fs.openSync(stage, "wx", 0o600));
    try {
      storageWrite(stage, () => {
        fs.writeFileSync(fd, plan.data);
        fs.fsyncSync(fd);
      });
    } finally {
      fs.closeSync(fd);
    }
  }
  hook?.("prepared");
  if (!exists(sealed)) {
    if (!exists(active) || digest(fs.readFileSync(active)) !== plan.old)
      fail(
        "SCRATCH_REPAIR_HELD",
        "Original journal missing before seal; preserve all repair state",
      );
    storageWrite(sealed, () => fs.renameSync(active, sealed));
  }
  if (digest(fs.readFileSync(sealed)) !== plan.old)
    fail("SCRATCH_REPAIR_HELD", "Original sealed journal changed; preserve repair intent");
  hook?.("sealed");
  if (exists(active)) fail("SCRATCH_REPAIR_STALE", "Journal reappeared during repair; retain it");
  storageWrite(active, () => fs.renameSync(stage, active));
  const fd = fs.openSync(ctx.home, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  hook?.("installed");
  if (digest(fs.readFileSync(active)) !== plan.next)
    fail("SCRATCH_REPAIR_HELD", "Replacement journal changed before completion");
  fs.unlinkSync(intent);
  clearScratchCache(ctx.home);
  return {
    outcome: "SCRATCH_RECOVERED",
    sealed,
    preserved: true,
    message:
      "Original bytes and unresolved ownership retained; unknown artifacts still require inspection",
  };
}
