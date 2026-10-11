import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { load, withLock, runtimePath } from "../src/state";
import { atomicJson } from "../src/files";
import { fixture } from "./helpers";
const linux = process.platform === "linux" ? test : test.skip;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function ready(path: string) {
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(path)) return;
    await pause(20);
  }
  throw new Error("Child did not reach checkpoint");
}
function kernel(home: string) {
  const ctx = load(home);
  ctx.manifest.lockBackend = "flock";
  atomicJson(join(home, "skilltree.json"), ctx.manifest);
  return load(home);
}
linux("kernel contention uses a stable inode and ignores TMPDIR", () => {
  const f = fixture();
  try {
    const ctx = kernel(f.home);
    const code = `import {load,withLock} from './src/state.ts'; try {withLock(load(process.argv[1]),()=>{}); console.log('ACQUIRED')} catch(e){console.log(e.code)}`;
    const invoke = (temp: string) =>
      Bun.spawnSync([process.execPath, "-e", code, f.home], {
        cwd: process.cwd(),
        env: { ...process.env, TMPDIR: temp },
        stdout: "pipe",
        stderr: "pipe",
      });
    const a = join(f.root, "tmp-a"),
      b = join(f.root, "tmp-b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    withLock(ctx, () => {
      expect(invoke(a).stdout.toString()).toContain("LOCKED");
      expect(invoke(b).stdout.toString()).toContain("LOCKED");
    });
    const inode = fs.statSync(join(ctx.runtime, "kernel.lock")).ino;
    expect(invoke(b).stdout.toString()).toContain("ACQUIRED");
    expect(fs.statSync(join(ctx.runtime, "kernel.lock")).ino).toBe(inode);
    expect(ctx.runtime).toBe(runtimePath(f.dest));
  } finally {
    f.cleanup();
  }
});
linux("process death releases flock without stale lock stealing", async () => {
  const f = fixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const ctx = kernel(f.home);
    const marker = join(f.root, "ready");
    const code = `import {load,withLock} from './src/state.ts'; import * as fs from 'node:fs'; withLock(load(process.argv[1]),()=>{fs.writeFileSync(process.argv[2],'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000)});`;
    child = Bun.spawn([process.execPath, "-e", code, f.home, marker], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    await ready(marker);
    expect(() => withLock(ctx, () => {})).toThrow(expect.objectContaining({ code: "LOCKED" }));
    child.kill("SIGKILL");
    await child.exited;
    expect(withLock(ctx, () => "released")).toBe("released");
    expect(fs.existsSync(join(ctx.runtime, "lock"))).toBe(false);
  } finally {
    child?.kill();
    f.cleanup();
  }
});
linux("surviving Git subprocess retains kernel lock after owner death", async () => {
  const f = fixture();
  const release = join(f.root, "release");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const ctx = kernel(f.home);
    const marker = join(f.root, "child-ready");
    const tools = join(f.root, "tools");
    fs.mkdirSync(tools);
    const q = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(
      join(tools, "git"),
      `#!/bin/sh\necho ready > ${q(marker)}\nwhile [ ! -f ${q(release)} ]; do sleep 0.05; done\n`,
      { mode: 0o755 },
    );
    const code = `import {load,withLock} from './src/state.ts'; import {git} from './src/git.ts'; withLock(load(process.argv[1]),()=>git(process.argv[2],['--version']));`;
    child = Bun.spawn([process.execPath, "-e", code, f.home, f.repo], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: tools + ":" + process.env.PATH },
      stdout: "pipe",
      stderr: "pipe",
    });
    await ready(marker);
    child.kill("SIGKILL");
    await child.exited;
    expect(() => withLock(ctx, () => {})).toThrow(expect.objectContaining({ code: "LOCKED" }));
    fs.writeFileSync(release, "release");
    let acquired = false;
    for (let i = 0; i < 100; i++) {
      try {
        withLock(ctx, () => {});
        acquired = true;
        break;
      } catch {
        await pause(20);
      }
    }
    expect(acquired).toBe(true);
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, "release");
    child?.kill();
    f.cleanup();
  }
});
