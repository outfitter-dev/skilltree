import { execFileSync } from "node:child_process";
import { setLockDescriptor, lockDescriptor } from "./lock-descriptor";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  lockSchema,
  manifestSchema,
  journalSchema,
  fail,
  type Lock,
  type Manifest,
  type Journal,
} from "./model";
import { atomicJson, readJson, assertNoSymlinks, exists, inside } from "./files";

export interface Context {
  home: string;
  manifest: Manifest;
  lock: Lock;
  runtime: string;
}
export function runtimePath(home: string): string {
  return join(
    fs.realpathSync(process.platform === "linux" ? "/tmp" : tmpdir()),
    "skilltree-runtime",
    createHash("sha256").update(resolve(home)).digest("hex"),
  );
}
export function load(home: string): Context {
  home = assertNoSymlinks(home);
  const manifest = manifestSchema.parse(readJson(join(home, "skilltree.json")));
  manifest.destination = assertNoSymlinks(manifest.destination);
  if (inside(home, manifest.destination) || inside(manifest.destination, home))
    fail("PATH_OVERLAP", "Durable state and destination must be separate");
  const lock = lockSchema.parse(readJson(join(home, "skilltree.lock")));
  if (
    new Set(lock.entries.map((e) => e.id)).size !== lock.entries.length ||
    new Set(lock.sources.map((s) => s.id)).size !== lock.sources.length
  )
    fail("STATE_INVALID", "Duplicate ownership/source IDs");
  for (const entry of lock.entries)
    if (!lock.sources.some((s) => s.id === entry.source))
      fail("STATE_INVALID", "Selection refers to an unknown source");
  return { home, manifest, lock, runtime: runtimePath(manifest.destination) };
}
export function save(ctx: Context): void {
  atomicJson(join(ctx.home, "skilltree.lock"), lockSchema.parse(ctx.lock));
}
export function pending(ctx: Context): Journal | null {
  const path = join(ctx.home, "transaction.json");
  return exists(path) ? journalSchema.parse(readJson(path)) : null;
}
export function withLock<T>(ctx: Context, work: () => T, allowRecovery = false): T {
  assertNoSymlinks(ctx.runtime);
  fs.mkdirSync(ctx.runtime, { recursive: true });
  if (ctx.manifest.lockBackend === "flock") {
    if (process.platform !== "linux")
      fail("LOCK_UNAVAILABLE", "Configured flock backend requires Linux");
    if (exists(join(ctx.runtime, "lock")))
      fail("LOCKED", "Legacy directory lock must be explicitly recovered before kernel locking");
    if (lockDescriptor() !== null) fail("LOCKED", "Nested kernel lock is unsupported");
    const path = assertNoSymlinks(join(ctx.runtime, "kernel.lock"));
    const fd = fs.openSync(path, "a+", 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) fail("UNSAFE_PATH", "Kernel lock must be a regular file");
      try {
        execFileSync("flock", ["-n", "-E", "73", "3"], { stdio: ["ignore", "pipe", "pipe", fd] });
      } catch (error) {
        if ((error as { status?: number }).status === 73)
          fail("LOCKED", "Another run holds the kernel lock");
        fail("LOCK_UNAVAILABLE", "Cannot acquire configured util-linux flock; no fallback");
      }
      setLockDescriptor(fd);
      if (!allowRecovery && pending(ctx))
        fail(
          "RECOVERY_REQUIRED",
          "Interrupted replacement exists; run recover before other writes",
        );
      return work();
    } finally {
      setLockDescriptor(null);
      fs.closeSync(fd);
    }
  }
  const kernel = join(ctx.runtime, "kernel.lock");
  if (exists(kernel))
    fail("LOCKED", "Kernel lock domain exists; retain configured backend or migrate explicitly");
  const lockDir = join(ctx.runtime, "lock");
  try {
    fs.mkdirSync(lockDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      fail(
        "LOCKED",
        "Another run or stale runtime lock exists; inspect doctor and recover --unlock",
      );
    throw e;
  }
  try {
    atomicJson(join(lockDir, "owner.json"), { pid: process.pid });
    if (!allowRecovery && pending(ctx))
      fail("RECOVERY_REQUIRED", "Interrupted replacement exists; run recover before other writes");
    return work();
  } finally {
    fs.rmSync(lockDir, { recursive: true });
  }
}
export function unlock(ctx: Context, dryRun: boolean): { stale: boolean } {
  const dir = join(ctx.runtime, "lock");
  assertNoSymlinks(dir);
  if (!exists(dir)) return { stale: false };
  const owner = readJson(join(dir, "owner.json")) as { pid?: unknown };
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0)
    fail("LOCKED", "Lock owner is unavailable; inspect manually rather than stealing a lock");
  try {
    process.kill(owner.pid as number, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH")
      fail("LOCKED", "Cannot prove the lock owner has exited");
    if (!dryRun) fs.rmSync(dir, { recursive: true });
    return { stale: true };
  }
  return fail("LOCKED", "Lock owner is still alive");
}
