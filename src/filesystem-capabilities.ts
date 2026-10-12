import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fail } from "./model";
import { inside } from "./files";

// mount IDs distinguish bind mounts too; overlayfs st_dev is not a mount identity.
export function mountTable(): string {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return fail(
      "BACKUP_CAPABILITY",
      "Linux mount inspection requires readable /proc/self/mountinfo",
    );
  }
}
export function mountId(path: string, table?: string): string {
  if (table === undefined) {
    let fd: number | undefined;
    try {
      // Linux O_PATH | O_NOFOLLOW inspects the entry without reading it or following links.
      fd = fs.openSync(path, 0x200000 | 0x20000);
      const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
      const id = /^mnt_id:\s+(\d+)$/m.exec(info)?.[1];
      if (!id) fail("BACKUP_CAPABILITY", `Kernel mount ID unavailable: ${path}`);
      return id!;
    } catch {
      return fail(
        "BACKUP_CAPABILITY",
        `Kernel O_PATH/fdinfo mount inspection unavailable: ${path}`,
      );
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  const candidates = table
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.split(" ");
      const point = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(parseInt(octal, 8)),
      );
      if (!/^\d+$/.test(fields[0] ?? "") || !point?.startsWith("/") || !fields.includes("-"))
        fail("BACKUP_CAPABILITY", "Linux mount table is invalid");
      return { id: fields[0]!, point: point! };
    })
    .filter(({ point }) => inside(point, resolve(path)))
    .sort((a, b) => b.point.length - a.point.length);
  if (!candidates[0]) fail("BACKUP_CAPABILITY", `Mount identity unavailable: ${path}`);
  return candidates[0]!.id;
}
function existingAncestor(path: string): string {
  while (!fs.existsSync(path)) {
    const parent = dirname(path);
    if (parent === path) fail("BACKUP_CAPABILITY", `No existing ancestor: ${path}`);
    path = parent;
  }
  return path;
}
export function sameMount(a: string, b: string): boolean {
  a = existingAncestor(a);
  b = existingAncestor(b);
  if (process.platform !== "linux") return fs.lstatSync(a).dev === fs.lstatSync(b).dev;
  const table = mountTable();
  const same = mountId(a) === mountId(b);
  if (mountTable() !== table)
    fail("BACKUP_CHANGED", "Mount table changed during filesystem preflight");
  return same;
}

export interface PythonIdentity {
  path: string;
  sha256: string;
  version: string;
}
let pinned:
  | { identity: PythonIdentity; ino: number; dev: number; mtime: number; size: number }
  | undefined;
export function checkedPython(path = "/usr/bin/python3"): PythonIdentity {
  try {
    const canonical = fs.realpathSync(path),
      stat = fs.statSync(canonical);
    if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
      fail(
        "BACKUP_CAPABILITY",
        `Python 3 interpreter must be a root-owned non-writable regular executable: ${canonical}`,
      );
    if (path === "/usr/bin/python3" && pinned) {
      if (
        pinned.identity.path !== canonical ||
        pinned.ino !== stat.ino ||
        pinned.dev !== stat.dev ||
        pinned.mtime !== stat.mtimeMs ||
        pinned.size !== stat.size
      )
        fail(
          "BACKUP_CAPABILITY",
          `Pinned Python 3 interpreter changed during this run: ${canonical}`,
        );
      return pinned.identity;
    }
    const version = execFileSync(canonical, ["-I", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
    if (!/^Python 3\.\d+\.\d+(?:\S*)$/.test(version))
      fail("BACKUP_CAPABILITY", `Python 3 interpreter version is unsupported: ${canonical}`);
    const identity = {
      path: canonical,
      version,
      sha256: createHash("sha256").update(fs.readFileSync(canonical)).digest("hex"),
    };
    if (path === "/usr/bin/python3")
      pinned = { identity, ino: stat.ino, dev: stat.dev, mtime: stat.mtimeMs, size: stat.size };
    return identity;
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("BACKUP_"))
      throw error;
    return fail("BACKUP_CAPABILITY", `Checked absolute Python 3 interpreter unavailable: ${path}`);
  }
}

// Linux POSIX ACLs are exposed as system.posix_acl_access/default xattrs.
// The standard-library inspector is embedded in both portable and native builds.
const LINUX_METADATA = `import json,os,sys
try:
 if not hasattr(os,"listxattr") or not hasattr(os,"getxattr"):
  raise RuntimeError("capability")
 for path in json.load(sys.stdin):
  try:
   attrs=os.listxattr(path,follow_symlinks=False)
   for name in attrs:
    os.getxattr(path,name,follow_symlinks=False)
   if attrs:
    print(json.dumps({"code":"BACKUP_UNSUPPORTED","path":path,"reason":"Extended attributes or ACLs cannot be faithfully restored"}))
    sys.exit(0)
  except OSError:
   print(json.dumps({"code":"BACKUP_CAPABILITY","path":path,"reason":"Filesystem metadata is unreadable or unsupported"}))
   sys.exit(0)
 print(json.dumps({"ok":True}))
except Exception:
 print(json.dumps({"code":"BACKUP_CAPABILITY","reason":"Python standard-library metadata inspection unavailable"}))
`;
export function checkMetadata(root: string, paths: string[]): void {
  if (process.platform === "linux") {
    let result: { ok?: boolean; code?: string; path?: string; reason?: string };
    try {
      result = JSON.parse(
        execFileSync(checkedPython().path, ["-I", "-c", LINUX_METADATA], {
          input: JSON.stringify(paths),
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30000,
        }),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).startsWith("BACKUP_"))
        throw error;
      fail(
        "BACKUP_CAPABILITY",
        `Python 3 with os.listxattr/getxattr is required for Linux metadata inspection: ${root}`,
      );
    }
    if (!result!.ok)
      fail(
        result!.code === "BACKUP_UNSUPPORTED" ? "BACKUP_UNSUPPORTED" : "BACKUP_CAPABILITY",
        `${result!.reason ?? "Invalid metadata inspector result"}: ${result!.path ?? root}`,
      );
    return;
  }
  if (process.platform !== "darwin")
    fail(
      "BACKUP_UNSUPPORTED",
      `Directory recovery is supported only on tested Unix filesystems: ${root}`,
    );
  for (const path of paths) {
    try {
      const attrs = execFileSync("/usr/bin/xattr", ["-s", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (attrs !== "" && attrs !== "com.apple.provenance\n")
        fail(
          "BACKUP_UNSUPPORTED",
          `Extended attributes beyond platform-managed provenance are unsupported: ${path}`,
        );
      const acl = execFileSync("/bin/ls", ["-led", path], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (/^.{10}\+|^\s*\d+: /m.test(acl))
        fail("BACKUP_UNSUPPORTED", `ACLs cannot be faithfully restored: ${path}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && String(error.code).startsWith("BACKUP_"))
        throw error;
      fail("BACKUP_CAPABILITY", `Readable metadata and macOS xattr/ls are required: ${path}`);
    }
  }
}
