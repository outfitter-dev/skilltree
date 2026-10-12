import * as fs from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
export interface BuildInfo {
  name: string;
  version: string;
  revision: string;
  dirty: boolean;
  sourceHash: string;
}
declare const SKILLTREE_BUILD_INFO: BuildInfo;
export function sourceBuildInfo(root: string): BuildInfo {
  const pkg = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const hash = createHash("sha256");
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (fs.statSync(path).isDirectory()) walk(path);
      else {
        hash.update(relative(root, path) + "\0");
        hash.update(fs.readFileSync(path));
      }
    }
  }
  walk(join(root, "src"));
  for (const name of ["package.json", "bun.lock"]) {
    hash.update(name + "\0");
    hash.update(fs.readFileSync(join(root, name)));
  }
  let revision = "unversioned",
    dirty = false;
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd: root,
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: 3000,
  };
  try {
    revision = execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"],
      options,
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) revision = "unversioned";
    dirty = !!execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "status", "--porcelain"],
      options,
    ).trim();
  } catch {
    /* Source hash identifies exports without Git metadata. */
  }
  return { name: pkg.name, version: pkg.version, revision, dirty, sourceHash: hash.digest("hex") };
}
export function buildInfo(): BuildInfo {
  if (typeof SKILLTREE_BUILD_INFO !== "undefined") return SKILLTREE_BUILD_INFO;
  return sourceBuildInfo(fileURLToPath(new URL("../", import.meta.url)));
}
