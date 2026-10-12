import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
const branch =
  process.env.GITHUB_HEAD_REF ??
  execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
const pending = fs.readdirSync(".changeset").filter((p) => p.endsWith(".md") && p !== "README.md");
if (branch === "changeset-release/main") process.exit(0);
const base = process.env.SKILLTREE_CHANGESET_BASE ?? "origin/main";
const files = execFileSync("git", ["diff", "--name-only", base + "...HEAD"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const facing = files.some(
  (p) =>
    /^(src\/|bin\/)/.test(p) ||
    ["package.json", "bun.lock", "README.md", "scripts/build.ts"].includes(p),
);
const added = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=A", base + "...HEAD", "--", ".changeset"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter((p) => p.endsWith(".md") && !p.endsWith("README.md"));
if (facing && !added.some((path) => pending.includes(path.slice(".changeset/".length))))
  throw new Error("Package-facing changes require a branch-owned .changeset/*.md release note");
console.log("Changeset release-intent check passed");
