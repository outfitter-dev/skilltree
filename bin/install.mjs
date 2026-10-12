#!/usr/bin/env node
// Local digest-verified runner installation. No downloads, hooks or service setup.
import * as fs from "node:fs";
import { resolve, join, dirname, parse, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
function safe(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const name of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, name);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Symlink installation path refused");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return absolute;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  const contains = (parent, child) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
  };
  const { values } = parseArgs({
    options: {
      prefix: { type: "string" },
      artifact: { type: "string" },
      sha256: { type: "string" },
      node: { type: "string" },
      restore: { type: "boolean" },
      "state-home": { type: "string" },
    },
  });
  if (!values.prefix) throw new Error("Explicit --prefix required");
  const prefix = safe(values.prefix);
  const stateHome = values["state-home"] ? safe(values["state-home"]) : prefix;
  if (values["state-home"] && (contains(prefix, stateHome) || contains(stateHome, prefix)))
    throw new Error("Durable runner state and disposable prefix must be separate");
  const receiptPath = safe(
    values["state-home"]
      ? join(stateHome, "runner-installations", digest(Buffer.from(prefix)) + ".json")
      : join(prefix, "installation.json"),
  );
  const receipt = values.restore
    ? JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    : {
        version: values["state-home"] ? 2 : 1,
        hash: values.sha256,
        node: values.node && fs.realpathSync(values.node),
        ...(values["state-home"] ? { prefix } : {}),
      };
  if (
    ![1, 2].includes(receipt.version) ||
    (receipt.version === 2 && receipt.prefix !== prefix) ||
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
  const approved = safe(join(stateHome, "runner-artifacts", `${receipt.hash}.mjs`));
  const artifact = values.restore ? approved : safe(values.artifact ?? "");
  if (!values.restore && !values.artifact) throw new Error("Explicit local --artifact required");
  const bytes = fs.readFileSync(artifact);
  if (digest(bytes) !== receipt.hash) throw new Error("Artifact digest mismatch");
  const runner = safe(join(prefix, "dist", `${receipt.hash}.mjs`));
  const launcher = safe(join(prefix, "bin", "skilltree"));
  const wrapper = `#!/bin/sh\nexec ${quote(receipt.node)} ${quote(runner)} "$@"\n`;
  const plan = [
    [approved, bytes, 0o600],
    [runner, bytes, 0o600],
    [launcher, Buffer.from(wrapper), 0o755],
    [receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + "\n"), 0o600],
  ];
  // Validate the entire destination plan before creating any file or directory.
  for (const [path, data] of plan) {
    let parent = dirname(path);
    while (!fs.existsSync(parent)) parent = dirname(parent);
    if (!fs.statSync(parent).isDirectory())
      throw new Error("Installation parent is not a directory");
    fs.accessSync(parent, fs.constants.R_OK | fs.constants.W_OK);
    if (fs.existsSync(path)) {
      if (!fs.lstatSync(path).isFile() || !fs.readFileSync(path).equals(data))
        throw new Error("Existing installation bytes differ; preserve and reconcile them");
    }
  }
  for (const [path, data, mode] of plan) {
    if (fs.existsSync(path)) continue;
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
