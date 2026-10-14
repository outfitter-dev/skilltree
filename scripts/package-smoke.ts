import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { hasInstallHook } from "./release-policy";
const input = process.argv[2];
if (!input) throw new Error("Pass a staged directory or exact registry version");
const stage = fs.existsSync(input) ? resolve(input) : null;
const receipt = stage ? JSON.parse(fs.readFileSync(join(stage, "release.json"), "utf8")) : null;
const spec = stage ? join(stage, receipt.tarball) : "@outfitter/skilltree@" + input;
if (!stage && !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+\.[0-9]+)?$/.test(input))
  throw new Error("Registry smoke requires an exact version");
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skilltree-package-smoke-")));
const cache = join(root, "cache"),
  node = process.env.SKILLTREE_SMOKE_NODE ?? "node";
const env = {
  ...process.env,
  npm_config_cache: cache,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};
execFileSync(
  "npm",
  ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", spec],
  { env, stdio: "pipe" },
);
const pkg = join(root, "node_modules/@outfitter/skilltree"),
  entry = join(pkg, "bin/skilltree.mjs"),
  metadata = JSON.parse(fs.readFileSync(join(pkg, "package.json"), "utf8"));
if (
  metadata.dependencies ||
  hasInstallHook(metadata.scripts) ||
  fs.existsSync(join(pkg, "dist/bin"))
)
  throw new Error("npm package must use the dependency-free portable runner");
const version = JSON.parse(execFileSync(node, [entry, "--version"], { encoding: "utf8", env }));
if (
  version.version !== (receipt?.version ?? input) ||
  (receipt &&
    (version.revision !== receipt.sourceCommit || version.sourceHash !== receipt.sourceHash))
)
  throw new Error("Installed build identity differs");
execFileSync(node, [entry, "--help"], { env, cwd: root, stdio: "pipe" });
// Exercise the installed package from a fresh directory without the source checkout or Bun.
const standalone = (args: string[]) =>
  JSON.parse(
    execFileSync(node, [entry, ...args, "--home", join(root, "standalone-state")], {
      env,
      cwd: root,
      encoding: "utf8",
    }),
  );
standalone(["setup", "--dest", join(root, "standalone-library"), "--exclusive-dest"]);
standalone(["verify"]);
const diagnostics = standalone(["doctor"]);
if (diagnostics.outcome !== "OK")
  throw new Error("Standalone installed-package diagnostics failed");

execFileSync(process.execPath, ["run", "demo"], {
  env: { ...env, SKILLTREE_DEMO_NODE: node, SKILLTREE_DEMO_ENTRY: entry },
  stdio: "inherit",
});
console.log(
  JSON.stringify({ outcome: "PACKAGE_VERIFIED", spec, build: version, retained: root }, null, 2),
);
