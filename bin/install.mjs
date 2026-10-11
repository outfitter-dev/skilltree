#!/usr/bin/env node
// Local digest-verified runner installation. No downloads, hooks or service setup.
import * as fs from "node:fs";
import { resolve, join, dirname, parse } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
function safe(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const name of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, name);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("Symlink installation path refused");
  }
  return absolute;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  const { values } = parseArgs({
    options: {
      prefix: { type: "string" },
      artifact: { type: "string" },
      sha256: { type: "string" },
      node: { type: "string" },
      restore: { type: "boolean" },
    },
  });
  if (!values.prefix) throw new Error("Explicit --prefix required");
  const prefix = safe(values.prefix),
    receiptPath = safe(join(prefix, "installation.json"));
  const receipt = values.restore
    ? JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    : { version: 1, hash: values.sha256, node: values.node && fs.realpathSync(values.node) };
  if (
    receipt.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(receipt.hash) ||
    !receipt.node ||
    !receipt.node.startsWith("/")
  )
    throw new Error("Explicit SHA256 and absolute --node required");
  const runtime = spawnSync(receipt.node, ["--version"], { encoding: "utf8" });
  if (
    runtime.status !== 0 ||
    Number(/^v(\d+)\./.exec(runtime.stdout)?.[1]) < 20 ||
    !/^v\d+\./.test(runtime.stdout)
  )
    throw new Error("Supported Node >=20 executable unavailable");
  const approved = safe(join(prefix, "runner-artifacts", `${receipt.hash}.mjs`));
  const artifact = values.restore ? approved : safe(values.artifact ?? "");
  if (!values.restore && !values.artifact) throw new Error("Explicit local --artifact required");
  const bytes = fs.readFileSync(artifact);
  if (digest(bytes) !== receipt.hash) throw new Error("Artifact digest mismatch");
  const runner = safe(join(prefix, "dist", `${receipt.hash}.mjs`));
  const launcher = safe(join(prefix, "bin", "skilltree"));
  const wrapper = `#!/bin/sh\nexec ${quote(receipt.node)} ${quote(runner)} "$@"\n`;
  for (const [path, data, mode] of [
    [approved, bytes, 0o600],
    [runner, bytes, 0o600],
    [launcher, Buffer.from(wrapper), 0o755],
    [receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + "\n"), 0o600],
  ]) {
    if (fs.existsSync(path)) {
      if (!fs.lstatSync(path).isFile() || !fs.readFileSync(path).equals(data))
        throw new Error("Existing installation bytes differ; preserve and reconcile them");
      continue;
    }
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, data, { flag: "wx", mode });
  }
  console.log(
    JSON.stringify({
      outcome: values.restore ? "RESTORED" : "INSTALLED",
      hash: receipt.hash,
      launcher,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      outcome: "INSTALL_HELD",
      message: error instanceof Error ? error.message : "Installation failed",
    }),
  );
  process.exitCode = 1;
}
