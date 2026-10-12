import { sourceBuildInfo } from "../src/version";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) {
  throw new Error("Compiled packaging is supported only for explicitly tested Unix targets");
}
mkdirSync("dist/bin", { recursive: true });
execFileSync(
  process.execPath,
  [
    "build",
    "src/cli.ts",
    "--compile",
    "--define",
    `SKILLTREE_BUILD_INFO:${JSON.stringify(sourceBuildInfo(process.cwd()))}`,
    `--outfile=dist/bin/skilltree-${process.platform}-${process.arch}`,
  ],
  { stdio: "inherit" },
);
