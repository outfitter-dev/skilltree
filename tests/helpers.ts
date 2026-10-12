import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../src/git";
import { execute } from "../src/service";
import { load } from "../src/state";

export function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skilltree-test-")));
  const repo = join(root, "upstream");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  const skill = join(repo, ".agents/skills/helper");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: helper\ndescription: Fixture helper\n---\nFirst line\n\nMiddle line\n\nLast line\n",
  );
  fs.mkdirSync(join(skill, "scripts"));
  fs.writeFileSync(join(skill, "scripts/run.sh"), "#!/bin/sh\necho original\n", { mode: 0o755 });
  commit(repo, "initial");
  const home = join(root, "state");
  const dest = join(root, "library");
  execute(home, "init", [], {
    destination: dest,
    exclusive: true,
    primary: "coordinator",
    lockBackend: "mkdir",
    runtimeRoot: join(root, "runtime"),
  });
  execute(home, "add", [repo], { source: "upstream", ref: "main" });
  return { root, repo, skill, home, dest, cleanup: () => fs.rmSync(root, { recursive: true }) };
}
export function commit(repo: string, message: string) {
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-m", message]);
}
export function install(home: string) {
  return execute(home, "select", ["upstream"], {
    path: ".agents/skills/helper",
    id: "helper",
    profile: "gardener",
    install: true,
    reason: "Explicit fixture installation request",
  });
}
export function candidate(home: string): string {
  return load(home).lock.entries[0]!.candidate!.hash;
}
export function approveApply(home: string) {
  const digest = candidate(home);
  execute(home, "approve", ["helper"], {
    hash: digest,
    reason: "Reviewed complete fixture snapshot",
  });
  return execute(home, "apply", ["helper"], { hash: digest });
}
export function body(path: string) {
  return fs.readFileSync(join(path, "SKILL.md"), "utf8");
}
export function editBody(path: string, from: string, to: string) {
  fs.writeFileSync(join(path, "SKILL.md"), body(path).replace(from, to));
}
export function authoritative(home: string): string {
  function entries(dir: string): string[] {
    return fs
      .readdirSync(dir)
      .sort()
      .flatMap((name) => {
        const path = join(dir, name);
        return fs.statSync(path).isDirectory()
          ? entries(path)
          : [path + ":" + fs.readFileSync(path).toString("base64")];
      });
  }
  return entries(home).join("\n");
}
