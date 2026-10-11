import * as fs from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { git, sourcePath } from "../src/git";
import { load } from "../src/state";

// Isolated restore contract demonstration, never a live host recovery hook.
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skilltree-restore-")));
const repo = join(root, "upstream"),
  home = join(root, "state"),
  dest = join(root, "library");
const runner = join(root, "disposable-runner"),
  artifact = join(root, "approved-runner.mjs");
const entry = join(runner, "skilltree.mjs");
const node = process.env.SKILLTREE_DEMO_NODE ?? "node";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bundle = fs.readFileSync(resolve("dist/cli.mjs"));
const approvedDigest = digest(bundle);
fs.writeFileSync(artifact, bundle, { flag: "wx" });
function restoreRunner() {
  const bytes = fs.readFileSync(artifact);
  if (digest(bytes) !== approvedDigest) throw new Error("Approved local runner artifact changed");
  fs.mkdirSync(runner);
  fs.writeFileSync(entry, bytes, { flag: "wx" });
}
function fingerprint(path: string): string {
  const hash = createHash("sha256");
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = join(dir, name),
        stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isSymbolicLink())
        hash.update(JSON.stringify([relative(path, file), fs.readlinkSync(file)]));
      else {
        hash.update(JSON.stringify([relative(path, file), stat.mode & 0o111]));
        hash.update(fs.readFileSync(file));
      }
    }
  }
  walk(path);
  return hash.digest("hex");
}
function cli(args: string[], expectedExit = 0) {
  let output: string;
  try {
    output = execFileSync(node, [entry, ...args, "--home", home], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const diagnostic = failed.stdout?.length ? failed.stdout : failed.stderr;
    if (failed.status !== expectedExit || !diagnostic?.length) throw error;
    output = diagnostic.toString();
  }
  const result = JSON.parse(output) as {
    outcome?: string;
    result?: { outcome?: string };
  };
  console.log(`${args[0]}: ${result.outcome ?? result.result?.outcome}`);
  return result;
}
fs.mkdirSync(join(repo, ".agents/skills/helper/build"), { recursive: true });
fs.writeFileSync(
  join(repo, ".agents/skills/helper/SKILL.md"),
  "---\nname: helper\ndescription: Restore fixture\n---\nOriginal\n",
);
fs.writeFileSync(
  join(repo, ".agents/skills/helper/build/guide.md"),
  "Tracked supporting material\n",
);
git(repo, ["init", "-b", "main"]);
git(repo, ["add", "--all", "--force"]);
git(repo, ["commit", "-m", "restore fixture"]);
restoreRunner();
cli(["init", "--dest", dest, "--exclusive-dest"]);
cli(["add", repo, "--source", "upstream", "--ref", "main"]);
cli([
  "select",
  "upstream",
  "--path",
  ".agents/skills/helper",
  "--id",
  "helper",
  "--install",
  "--reason",
  "Explicit restore-fixture install",
]);
fs.appendFileSync(join(dest, "helper/SKILL.md"), "Local improvement\n");
cli(["capture", "helper"]);
const accepted = fingerprint(home);
const library = fingerprint(dest);
fs.rmSync(runner, { recursive: true });
restoreRunner();
if (cli(["doctor"]).outcome !== "OK") throw new Error("Restored runner failed doctor");
if (cli(["verify"]).outcome !== "CURRENT") throw new Error("Restored runner failed verify");
if (fingerprint(home) !== accepted || fingerprint(dest) !== library)
  throw new Error("Restore checks changed durable state or library");
console.log("restore: approved local artifact; durable approvals/history/library unchanged");
// Model only the documented directory-pruning rule, not the live snapshot service.
const ctx = load(home);
fs.rmSync(join(sourcePath(home, ctx.lock.sources[0]!), ".agents/skills/helper/build"), {
  recursive: true,
});
fs.rmSync(join(home, "edits/helper/build"), { recursive: true });
const pruned = fingerprint(home);
if (cli(["doctor"], 1).outcome !== "ERROR") throw new Error("Incomplete restore was not diagnosed");
if (cli(["sync", "--dry-run"], 1).outcome !== "SOURCE_DIRTY")
  throw new Error("Incomplete restore was not held");
if (fingerprint(home) !== pruned || fingerprint(dest) !== library)
  throw new Error("Incomplete restore checks changed retained content");
console.log("incomplete snapshot: held; working checkout restore remains a Grok compatibility gap");
console.log(`Retained isolated restore: ${root}`);
