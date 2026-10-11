import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { git, sourcePath } from "../src/git";
import { load } from "../src/state";

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skilltree-demo-")));
const repo = join(root, "upstream"),
  home = join(root, "state"),
  dest = join(root, "library");
const skill = join(repo, ".agents/skills/helper");
fs.mkdirSync(skill, { recursive: true });
fs.writeFileSync(
  join(skill, "SKILL.md"),
  "---\nname: helper\ndescription: Demo helper\n---\nFirst line\n\nMiddle line\n\nLast line\n",
);
fs.writeFileSync(join(repo, "README.md"), "Demo repository notes\n");
fs.symlinkSync("README.md", join(repo, "CLAUDE.md"));
fs.mkdirSync(join(repo, "docs"));
fs.symlinkSync("../README.md", join(repo, "docs/readme.md"));
git(repo, ["init", "-b", "main"]);
git(repo, ["add", "--all"]);
git(repo, ["commit", "-m", "demo source"]);
const runner = process.env.SKILLTREE_DEMO_NODE;
const entry = resolve(process.env.SKILLTREE_DEMO_ENTRY ?? "dist/cli.mjs");
function cli(args: string[]) {
  const executable = runner ?? "node";
  let output: string;
  try {
    output = execFileSync(executable, [entry, ...args, "--home", home], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (args[0] !== "verify" || failure.status !== 1 || !failure.stdout) throw error;
    output = failure.stdout;
  }
  const result = JSON.parse(output) as {
    outcome?: string;
    result?: { outcome?: string };
    entries?: Array<{ candidate: { hash: string }; outcome: string; drift: boolean }>;
  };
  console.log(`${args[0]}: ${result.outcome ?? result.result?.outcome ?? "OK"}`);
  return result;
}
cli(["init", "--dest", dest, "--exclusive-dest"]);
cli(["add", repo, "--source", "demo", "--ref", "main"]);
cli(["inventory", "demo"]);
cli([
  "select",
  "demo",
  "--path",
  ".agents/skills/helper",
  "--id",
  "helper",
  "--profile",
  "gardener",
  "--install",
  "--reason",
  "Explicit demo install",
]);
const target = join(dest, "helper/SKILL.md");
fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("First line", "Local first"));
cli(["verify"]);
cli(["capture", "helper"]);
fs.writeFileSync(
  join(skill, "SKILL.md"),
  fs.readFileSync(join(skill, "SKILL.md"), "utf8").replace("Last line", "Upstream last"),
);
git(repo, ["add", "--all"]);
git(repo, ["commit", "-m", "upstream update"]);
cli(["sync", "--dry-run"]);
cli(["sync"]);
const status = cli(["status"]);
const digest = status.entries![0]!.candidate.hash;
cli(["approve", "helper", "--hash", digest, "--reason", "Reviewed demo candidate"]);
cli(["apply", "helper", "--hash", digest]);
cli(["list", "--profile", "gardener"]);
cli(["verify"]);
cli(["doctor"]);
const final = fs.readFileSync(target, "utf8");
if (!final.includes("Local first") || !final.includes("Upstream last"))
  throw new Error("Demo lost an edit");
console.log("content: local and upstream edits preserved");
const acquired = sourcePath(home, load(home).lock.sources[0]!);
if (
  fs.readlinkSync(join(acquired, "CLAUDE.md")) !== "README.md" ||
  fs.readlinkSync(join(acquired, "docs/readme.md")) !== "../README.md"
)
  throw new Error("Repository symlink text changed during acquisition");
console.log("repository: relative symlinks preserved");
console.log(`Retained isolated demo: ${root}`);
