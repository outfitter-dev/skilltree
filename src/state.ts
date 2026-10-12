import { execFileSync } from "node:child_process";
import { setLockDescriptors, lockDescriptor } from "./lock-descriptor";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
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
export function runtimePath(destination: string, root?: string, version?: number): string {
  const base = root
    ? assertNoSymlinks(root)
    : version === 2 && process.platform === "linux"
      ? join(userInfo().homedir, ".local", "state", "skilltree")
      : join(
          fs.realpathSync(process.platform === "linux" ? "/tmp" : tmpdir()),
          version === 2 ? "skilltree-runtime-v2" : "skilltree-runtime",
        );
  return join(base, createHash("sha256").update(resolve(destination)).digest("hex"));
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
  return {
    home,
    manifest,
    lock,
    runtime: runtimePath(manifest.destination, manifest.runtimeRoot, manifest.runtimeVersion),
  };
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
  const marker = join(ctx.runtime, "domain.json");
  if (ctx.manifest.runtimeVersion === 2) {
    if (exists(marker)) {
      const value = readJson(marker) as { version?: unknown; destination?: unknown };
      if (value.version !== 2 || value.destination !== ctx.manifest.destination)
        fail("LOCKED", "Runtime domain belongs to another collection");
    } else atomicJson(marker, { version: 2, destination: ctx.manifest.destination });
  }
  const runtimes = [
    ctx.runtime,
    ...(ctx.manifest.legacyRuntime && ctx.manifest.legacyRuntime !== ctx.runtime
      ? [assertNoSymlinks(ctx.manifest.legacyRuntime)]
      : []),
  ];
  if (ctx.manifest.lockBackend === "flock") {
    if (process.platform !== "linux")
      fail("LOCK_UNAVAILABLE", "Configured flock backend requires Linux");
    if (lockDescriptor() !== null) fail("LOCKED", "Nested kernel lock is unsupported");
    const descriptors: number[] = [];
    try {
      for (const runtime of runtimes) {
        fs.mkdirSync(runtime, { recursive: true });
        if (exists(join(runtime, "lock")))
          fail(
            "LOCKED",
            "Legacy directory writer/stale lock blocks migration; stop old writers and recover explicitly",
          );
        const path = assertNoSymlinks(
          join(
            runtime,
            runtime === ctx.runtime && ctx.manifest.runtimeVersion === 2
              ? "sync.lock"
              : (ctx.manifest.legacyLockName ?? "kernel.lock"),
          ),
        );
        const fd = fs.openSync(path, "a+", 0o600);
        descriptors.push(fd);
        if (!fs.fstatSync(fd).isFile()) fail("UNSAFE_PATH", "Kernel lock must be a regular file");
        try {
          execFileSync("flock", ["-n", "-E", "73", "3"], { stdio: ["ignore", "pipe", "pipe", fd] });
        } catch (error) {
          if ((error as { status?: number }).status === 73)
            fail("LOCKED", "Another run holds the kernel or legacy compatibility lock");
          fail("LOCK_UNAVAILABLE", "Configured util-linux flock unavailable; no fallback");
        }
        if (exists(join(runtime, "lock")))
          fail("LOCKED", "Unsupported mixed-version directory writer detected");
      }
      setLockDescriptors(descriptors);
      if (!allowRecovery && pending(ctx))
        fail(
          "RECOVERY_REQUIRED",
          "Interrupted replacement exists; run recover before other writes",
        );
      return work();
    } finally {
      setLockDescriptors([]);
      for (const fd of descriptors) fs.closeSync(fd);
    }
  }
  const acquired: string[] = [];
  try {
    for (const runtime of runtimes) {
      fs.mkdirSync(runtime, { recursive: true });
      if (exists(join(runtime, "kernel.lock")) || exists(join(runtime, "sync.lock")))
        fail("LOCKED", "Kernel domain exists; stop mixed-version writers and migrate explicitly");
      const dir = join(runtime, "lock");
      try {
        fs.mkdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          fail(
            "LOCKED",
            "Another run or stale runtime lock exists; inspect doctor and recover --unlock",
          );
        throw error;
      }
      acquired.push(dir);
      atomicJson(join(dir, "owner.json"), { pid: process.pid });
    }
    if (!allowRecovery && pending(ctx))
      fail("RECOVERY_REQUIRED", "Interrupted replacement exists; run recover before other writes");
    return work();
  } finally {
    for (const dir of acquired.reverse()) fs.rmSync(dir, { recursive: true });
  }
}
export function unlock(ctx: Context, dryRun: boolean): { stale: boolean } {
  const dirs = [
    ctx.runtime,
    ...(ctx.manifest.legacyRuntime ? [ctx.manifest.legacyRuntime] : []),
  ].map((root) => assertNoSymlinks(join(root, "lock")));
  const stale: string[] = [];
  for (const dir of dirs) {
    if (!exists(dir)) continue;
    if (fs.readdirSync(dir).some((name) => name !== "owner.json"))
      fail("LOCKED", "Unknown lock files require manual inspection");
    const owner = readJson(join(dir, "owner.json")) as { pid?: unknown };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0)
      fail("LOCKED", "Lock owner unavailable; inspect rather than stealing");
    try {
      process.kill(owner.pid as number, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        fail("LOCKED", "Cannot prove owner exited");
      stale.push(dir);
      continue;
    }
    fail("LOCKED", "Lock owner is still alive");
  }
  if (!dryRun)
    for (const dir of stale) {
      fs.unlinkSync(join(dir, "owner.json"));
      fs.rmdirSync(dir);
    }
  return { stale: stale.length > 0 };
}
