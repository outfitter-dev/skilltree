import * as fs from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  evaluateRelease,
  releaseRepository,
  workflowPassed,
  hasChangelogHeading,
  type ExpectedCheck,
  type WorkflowEvidence,
  type Evidence,
} from "./release-policy";
const registry = "https://registry.npmjs.org/",
  packageName = "@outfitter/skilltree";
const root = process.cwd();
const args = process.argv.slice(2),
  command = args.shift();
function option(name: string) {
  const at = args.indexOf("--" + name);
  return at < 0 ? undefined : args[at + 1];
}
function needed(name: string) {
  const value = option(name);
  if (!value || value.startsWith("--")) throw new Error("Missing --" + name);
  return value;
}
function run(tool: string, argv: string[], cwd = root) {
  return execFileSync(tool, argv, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
const git = (...argv: string[]) => run("git", ["-c", "core.fsmonitor=false", ...argv]);
const gh = (path: string) => JSON.parse(run("gh", ["api", path]));
const file = (path: string) => JSON.parse(fs.readFileSync(path, "utf8"));
const digest = (bytes: Buffer, algorithm = "sha256") =>
  createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
function outputs(values: Record<string, string | boolean>) {
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(values)) {
      if (!/^[a-z_]+$/.test(key) || String(value).includes("\n"))
        throw new Error("Invalid workflow output");
      fs.appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
    }
  console.log(JSON.stringify(values, null, 2));
}
async function metadata(version: string) {
  const response = await fetch(registry + "@outfitter%2fskilltree");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Registry lookup failed: " + response.status);
  const document = (await response.json()) as {
    versions?: Record<
      string,
      { dist?: { integrity?: string; attestations?: { provenance?: unknown } } }
    >;
    "dist-tags"?: Record<string, string>;
  };
  return { entry: document.versions?.[version] ?? null, tags: document["dist-tags"] ?? {} };
}
function clean() {
  if (git("status", "--porcelain")) throw new Error("Release source must be clean");
}
function identity() {
  const pkg = file("package.json");
  if (
    pkg.name !== packageName ||
    pkg.private === true ||
    pkg.publishConfig?.access !== "public" ||
    pkg.repository?.url !== "git+https://github.com/outfitter-dev/skilltree.git" ||
    pkg.dependencies ||
    pkg.scripts?.prepublishOnly !== "node scripts/publish-guard.mjs" ||
    pkg.scripts?.postinstall ||
    pkg.files.includes("dist/bin/")
  )
    throw new Error("Unexpected public package contract");
  return pkg;
}
function stage() {
  const pkg = identity(),
    dir = resolve(needed("dir"));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length)
    throw new Error("Stage directory must be new or empty");
  fs.mkdirSync(dir, { recursive: true });
  run(process.execPath, ["run", "build"]);
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir]),
  )[0];
  const allowed = new Set([
    "package.json",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "bin/install.mjs",
    "bin/skilltree.mjs",
    "dist/cli.mjs",
    "docs/implementation-plan.md",
    "docs/releases.md",
    "docs/grok-bot/architecture-and-gaps.md",
    "docs/grok-bot/bot-profile.md",
    "docs/grok-bot/environment.md",
    "docs/grok-bot/setup.md",
    "skills/skilltree/SKILL.md",
    "agents/gardener.md",
  ]);
  const paths = packed.files.map((row: { path: string }) => row.path);
  if (paths.length !== allowed.size || paths.some((path: string) => !allowed.has(path)))
    throw new Error("Unexpected package payload");
  const bytes = fs.readFileSync(join(dir, packed.filename)),
    build = JSON.parse(
      run(process.env.SKILLTREE_SMOKE_NODE ?? "node", ["dist/cli.mjs", "--version"]),
    );
  if (build.version !== pkg.version || build.revision !== git("rev-parse", "HEAD"))
    throw new Error("Build identity differs");
  const receipt = {
    version: pkg.version,
    sourceCommit: build.revision,
    sourceHash: build.sourceHash,
    dirty: build.dirty,
    tarball: packed.filename,
    sha256: digest(bytes),
    integrity: "sha512-" + digest(bytes, "sha512"),
    files: paths,
  };
  fs.writeFileSync(join(dir, "release.json"), JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(JSON.stringify(receipt, null, 2));
}
function checkPassed(expected: ExpectedCheck) {
  const path =
    "repos/" +
    releaseRepository +
    "/actions/workflows/check.yml/runs?per_page=100&head_sha=" +
    expected.sha +
    "&event=" +
    expected.event;
  const runs = gh(path).workflow_runs as WorkflowEvidence[];
  return workflowPassed(runs, expected);
}

async function labels() {
  if (
    process.env.GITHUB_REPOSITORY !== releaseRepository ||
    process.env.GITHUB_REF !== "refs/heads/main"
  )
    throw new Error("Version labels require the main release workflow");
  const prs = gh(
    "repos/" + releaseRepository + "/pulls?state=open&head=outfitter-dev:changeset-release/main",
  ) as {
    number: number;
    title: string;
    user: { login: string };
    head: { sha: string };
    labels: { name: string }[];
  }[];
  const pr = prs.find(
    (p) => p.title === "chore(release): version packages" && p.user.login === "github-actions[bot]",
  );
  if (!pr) throw new Error("Expected generated version PR unavailable");
  const content = gh("repos/" + releaseRepository + "/contents/package.json?ref=" + pr.head.sha);
  const proposed = JSON.parse(Buffer.from(content.content, "base64").toString()).version as string;
  const pending = fs
    .readdirSync(".changeset")
    .filter((p) => p.endsWith(".md") && p !== "README.md");
  const sourcePrs = pending.flatMap((path) => {
    const sha = git("log", "-n", "1", "--diff-filter=A", "--format=%H", "--", ".changeset/" + path);
    return sha ? gh("repos/" + releaseRepository + "/commits/" + sha + "/pulls") : [];
  }) as { labels: { name: string }[] }[];
  const auto =
    !proposed.includes("-") &&
    pending.length > 0 &&
    sourcePrs.length > 0 &&
    sourcePrs.every(
      (p) =>
        p.labels.some((l) => l.name === "stack:boundary") &&
        p.labels
          .filter((l) => l.name.startsWith("stack:"))
          .every((l) => l.name === "stack:boundary"),
    );
  const old = identity().version as string;
  const delta =
    old.split(".")[0] !== proposed.split(".")[0]
      ? "major"
      : old.split(".")[1] !== proposed.split(".")[1]
        ? "minor"
        : "patch";
  const wanted = [
    auto ? "publish:auto" : "publish:manual",
    proposed.includes("-") ? "channel:preview" : "channel:stable",
    "release:" + delta,
  ];
  const add = wanted.filter(
    (l) => !pr.labels.some((p) => p.name.startsWith(l.split(":")[0] + ":")),
  );
  for (const name of add) {
    try {
      gh("repos/" + releaseRepository + "/labels/" + encodeURIComponent(name));
    } catch {
      run("gh", [
        "api",
        "--method",
        "POST",
        "repos/" + releaseRepository + "/labels",
        "-f",
        "name=" + name,
        "-f",
        "color=0366d6",
      ]);
    }
  }
  if (add.length)
    run("gh", [
      "api",
      "--method",
      "POST",
      "repos/" + releaseRepository + "/issues/" + pr.number + "/labels",
      ...add.flatMap((l) => ["-f", "labels[]=" + l]),
    ]);
}
async function policy() {
  clean();
  const pkg = identity(),
    version = pkg.version as string;
  const current = git("rev-parse", "HEAD"),
    candidate = git(
      "log",
      "-n",
      "1",
      "--format=%H",
      "-S",
      '"version": "' + version + '"',
      "--",
      "package.json",
    );
  const source = version === "0.1.0-rc.0" ? current : candidate;
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Version commit unavailable");
  const pulls = gh("repos/" + releaseRepository + "/commits/" + source + "/pulls") as {
    number: number;
    merged_at: string | null;
    created_at: string;
    title: string;
    body: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    user: { login: string };
    labels: { name: string }[];
  }[];
  const pr = pulls.find(
    (p) =>
      p.merged_at &&
      p.head.ref === "changeset-release/main" &&
      p.base.ref === "main" &&
      p.title === "chore(release): version packages",
  );
  let passed = false;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (!passed) {
    passed =
      checkPassed({ sha: source, branch: "main", event: "push" }) &&
      (!pr ||
        checkPassed({
          sha: pr.head.sha,
          branch: pr.head.ref,
          event: "pull_request",
          created: pr.created_at,
          merged: pr.merged_at!,
        }));
    if (passed || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  const parent = git("rev-parse", source + "^"),
    before = JSON.parse(git("show", parent + ":package.json")),
    after = JSON.parse(git("show", source + ":package.json"));
  const oldVersion = before.version;
  delete before.version;
  delete after.version;
  const changed = git("diff", "--name-only", parent, source).split("\n").filter(Boolean);
  const removed = git("diff", "--diff-filter=D", "--name-only", parent, source, "--", ".changeset")
    .split("\n")
    .filter((p) => p.endsWith(".md") && !p.endsWith("README.md"));
  const sourcePrs = removed.flatMap((path) => {
    const introducing = git("log", "-n", "1", "--diff-filter=A", "--format=%H", parent, "--", path);
    return introducing
      ? gh("repos/" + releaseRepository + "/commits/" + introducing + "/pulls")
      : [];
  }) as { labels: { name: string }[] }[];
  const commit = git("show", "-s", "--format=%s%n%an%n%ae%n%cn%n%ce", source).split("\n");
  const evidence: Evidence = {
    repository: process.env.GITHUB_REPOSITORY ?? "local",
    ref: process.env.GITHUB_REF ?? "local",
    version,
    previousVersion: oldVersion,
    labels: pr?.labels.map((l) => l.name) ?? [],
    ciPassed: passed,
    generatedPr: !!pr && pr.user.login === "github-actions[bot]",
    botCommit:
      /^chore\(release\): version packages \(#\d+\)$/.test(commit[0] ?? "") &&
      commit[1] === "github-actions[bot]" &&
      commit[2] === "41898282+github-actions[bot]@users.noreply.github.com" &&
      commit[3] === "GitHub" &&
      commit[4] === "noreply@github.com",
    versionOnly:
      hasChangelogHeading(git("show", source + ":CHANGELOG.md"), version) &&
      isDeepStrictEqual(before, after) &&
      changed.every(
        (p) =>
          ["package.json", "bun.lock", "CHANGELOG.md", ".changeset/pre.json"].includes(p) ||
          removed.includes(p),
      ),
    sourceBoundary:
      removed.length > 0 &&
      sourcePrs.length > 0 &&
      sourcePrs.every(
        (p) =>
          p.labels.some((l) => l.name === "stack:boundary") &&
          p.labels
            .filter((l) => l.name.startsWith("stack:"))
            .every((l) => l.name === "stack:boundary"),
      ),
    noneReason: /release-reason:\s*\S+/.test(pr?.body ?? ""),
  };
  const result = evaluateRelease(evidence),
    found = await metadata(version);
  if (result.decision === "block") throw new Error(result.reasons.join("; "));
  const should = result.decision !== "none" && source === current;
  if (should && (result.decision === "auto" || process.env.SKILLTREE_MANUAL_PUBLISH === "true")) {
    const env = gh("repos/" + releaseRepository + "/environments/" + result.environment);
    if (
      result.environment === "npm-auto" &&
      (env.protection_rules ?? []).some(
        (r: { type: string; reviewers?: unknown[] }) =>
          r.type === "required_reviewers" && r.reviewers?.length,
      )
    )
      throw new Error(
        "npm-auto must use reviewed-version policy without a second manual reviewer gate",
      );
    if (
      result.environment === "npm" &&
      !(env.protection_rules ?? []).some(
        (r: { type: string; reviewers?: unknown[] }) =>
          r.type === "required_reviewers" && r.reviewers?.length,
      )
    )
      throw new Error("Existing npm environment requires an approved reviewer protection rule");
    const rules = gh(
      "repos/" +
        releaseRepository +
        "/environments/" +
        result.environment +
        "/deployment-branch-policies",
    ).branch_policies as { name: string; type: string }[];
    if (
      !env.deployment_branch_policy?.custom_branch_policies ||
      rules.length !== 1 ||
      rules[0]?.name !== "main" ||
      rules[0]?.type !== "branch"
    )
      throw new Error("Existing release environment must allow only the main branch");
  }
  const ready =
    should && (result.decision === "auto" || process.env.SKILLTREE_MANUAL_PUBLISH === "true");
  outputs({
    decision: result.decision,
    environment: result.environment,
    tag: result.tag,
    version,
    source_commit: source,
    should_publish: should,
    registry_present: !!found?.entry,
    ready,
  });
  return { ...result, ready };
}
async function verify(dir: string, provenance: boolean) {
  const receipt = file(join(dir, "release.json")),
    bytes = fs.readFileSync(join(dir, basename(receipt.tarball)));
  if (receipt.sha256 !== digest(bytes) || receipt.integrity !== "sha512-" + digest(bytes, "sha512"))
    throw new Error("Staged tarball changed");
  const tag = receipt.version.includes("-")
    ? receipt.version.split("-")[1].split(".")[0]
    : "latest";
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = await metadata(receipt.version);
    if (found?.entry) {
      if (found.entry.dist?.integrity !== receipt.integrity)
        throw new Error("Occupied npm version has different immutable bytes");
      if (
        found.tags[tag] === receipt.version &&
        (!provenance || found.entry.dist?.attestations?.provenance)
      )
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 3000 + attempt * 3000)));
  }
  throw new Error(
    "Registry verification timed out; publication may have succeeded, inspect before retrying",
  );
}
async function publish(bootstrap: boolean) {
  clean();
  const pkg = identity(),
    dir = resolve(needed("dir")),
    receipt = file(join(dir, "release.json"));
  if (
    receipt.dirty ||
    receipt.sourceCommit !== git("rev-parse", "HEAD") ||
    receipt.version !== pkg.version
  )
    throw new Error("Stage does not match clean release source");
  const bytes = fs.readFileSync(join(dir, basename(receipt.tarball)));
  if (receipt.sha256 !== digest(bytes) || receipt.integrity !== "sha512-" + digest(bytes, "sha512"))
    throw new Error("Staged tarball changed");
  if (bootstrap) {
    if (
      process.env.GITHUB_ACTIONS === "true" ||
      pkg.version !== "0.1.0-rc.0" ||
      needed("confirm-version") !== pkg.version ||
      git("branch", "--show-current") !== "main"
    )
      throw new Error("Bootstrap requires the initial confirmed candidate on clean local main");
    const remote = git("ls-remote", "origin", "refs/heads/main").split("\t")[0];
    if (remote !== receipt.sourceCommit || needed("expect-sha256") !== receipt.sha256)
      throw new Error("Bootstrap must match live main and the reviewed tarball SHA256");
    if (!checkPassed({ sha: receipt.sourceCommit, branch: "main", event: "push" }))
      throw new Error("Exact main CI must pass before bootstrap");
    run("npm", ["whoami", "--registry=" + registry]);
  } else if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== releaseRepository ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.SKILLTREE_RELEASE_COMMIT !== receipt.sourceCommit
  )
    throw new Error("Normal publication requires the policy-selected GitHub main workflow");
  if (!bootstrap) {
    const resolved = await policy();
    if (!resolved.ready || resolved.environment !== process.env.SKILLTREE_RELEASE_ENVIRONMENT)
      throw new Error("Release policy changed before publication");
  }
  if (
    !bootstrap &&
    (!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  )
    throw new Error(
      "Trusted publication requires the GitHub OIDC exchange context; token fallback is disabled",
    );
  const existing = await metadata(pkg.version);
  if (existing?.entry) {
    await verify(dir, !bootstrap);
    console.log("Exact release already exists; no republish");
    return;
  }
  const tag = pkg.version.includes("-") ? pkg.version.split("-")[1].split(".")[0] : "latest";
  const isolated = bootstrap ? null : fs.mkdtempSync(join(tmpdir(), "skilltree-oidc-"));
  const env = { ...process.env };
  if (isolated) {
    for (const key of Object.keys(env))
      if (
        /^npm_/i.test(key) ||
        ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].includes(key)
      )
        delete env[key];
    const configuration = join(isolated, "npmrc");
    fs.writeFileSync(configuration, "registry=" + registry + "\n", { mode: 0o600 });
    env.npm_config_userconfig = configuration;
    env.npm_config_globalconfig = "/dev/null";
  }
  try {
    execFileSync(
      "npm",
      [
        "publish",
        join(dir, basename(receipt.tarball)),
        "--ignore-scripts",
        "--access",
        "public",
        "--registry=" + registry,
        "--tag",
        tag,
        ...(!bootstrap ? ["--provenance"] : []),
      ],
      { stdio: "inherit", env },
    );
  } finally {
    if (isolated) fs.rmSync(isolated, { recursive: true });
  }
  await verify(dir, !bootstrap);
  console.log("Verified npm publication: " + packageName + "@" + pkg.version + " (" + tag + ")");
}
try {
  if (command === "labels") await labels();
  else if (command === "stage") stage();
  else if (command === "policy") await policy();
  else if (command === "publish") await publish(false);
  else if (command === "bootstrap") await publish(true);
  else if (command === "verify") await verify(resolve(needed("dir")), true);
  else throw new Error("Use stage, policy, publish, bootstrap or verify");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release failed");
  process.exitCode = 1;
}
