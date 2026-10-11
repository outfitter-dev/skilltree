import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

mkdirSync("dist", { recursive: true });
execFileSync(
  process.execPath,
  ["build", "src/cli.ts", "--target=node", "--format=esm", "--outfile=dist/cli.mjs"],
  { stdio: "inherit" },
);
