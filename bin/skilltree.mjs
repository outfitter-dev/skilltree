#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const native = fileURLToPath(
  new URL(`../dist/bin/skilltree-${process.platform}-${process.arch}`, import.meta.url),
);
const bundle = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const command = existsSync(native) ? native : process.execPath;
const args = existsSync(native) ? process.argv.slice(2) : [bundle, ...process.argv.slice(2)];
if (!existsSync(native) && !existsSync(bundle)) {
  console.error(
    "Skilltree build is missing; use a prepared package or run bun run build in the source checkout.",
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error("Skilltree runner could not start.");
    process.exitCode = 1;
  } else process.exitCode = result.status ?? 1;
}
