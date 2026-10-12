import semver from "semver";
export const releaseRepository = "outfitter-dev/skilltree";
export interface Evidence {
  repository: string;
  ref: string;
  version: string;
  previousVersion: string | null;
  labels: string[];
  ciPassed: boolean;
  generatedPr: boolean;
  botCommit: boolean;
  versionOnly: boolean;
  sourceBoundary: boolean;
  noneReason: boolean;
}
export function evaluateRelease(e: Evidence) {
  const version = semver.valid(e.version);
  if (!version) throw new Error("Invalid release version");
  const pre = semver.prerelease(version),
    tag = pre ? String(pre[0]) : "latest";
  if (!new Set(["latest", "alpha", "beta", "rc", "canary", "next"]).has(tag))
    throw new Error("Unsupported release channel");
  const families = [
    ["publish:", ["publish:auto", "publish:manual", "publish:block", "publish:none"]],
    ["channel:", ["channel:stable", "channel:preview", "channel:canary"]],
    ["release:", ["release:major", "release:minor", "release:patch"]],
  ] as const;
  const blockers: string[] = [];
  for (const [prefix, allowed] of families) {
    const found = [...new Set(e.labels.filter((l) => l.startsWith(prefix)))];
    if (found.length > 1 || found.some((l) => !(allowed as readonly string[]).includes(l)))
      blockers.push("Conflicting or unknown " + prefix + " labels");
  }
  if (e.repository !== releaseRepository || e.ref !== "refs/heads/main")
    blockers.push("Release must originate on the expected main branch");
  if (e.labels.includes("publish:block")) blockers.push("publish:block is set");
  if (e.labels.includes("publish:none")) {
    if (!e.noneReason) blockers.push("publish:none requires a release-reason audit note");
    return {
      decision: blockers.length ? "block" : "none",
      tag,
      environment: "npm",
      reasons: blockers,
    };
  }
  if (!e.ciPassed) blockers.push("Exact release and PR-head checks have not passed");
  if (blockers.length) return { decision: "block", tag, environment: "npm", reasons: blockers };
  const delta =
    e.previousVersion && semver.lt(e.previousVersion, version)
      ? version.split(".")[0] !== e.previousVersion.split(".")[0]
        ? "major"
        : version.split(".")[1] !== e.previousVersion.split(".")[1]
          ? "minor"
          : "patch"
      : null;
  const auto =
    e.labels.includes("publish:auto") &&
    e.labels.includes("channel:stable") &&
    !pre &&
    delta !== null &&
    e.labels.includes("release:" + delta) &&
    e.generatedPr &&
    e.botCommit &&
    e.versionOnly &&
    e.sourceBoundary;
  return {
    decision: auto ? "auto" : "manual",
    tag,
    environment: auto ? "npm-auto" : "npm",
    reasons: auto
      ? []
      : ["Prerelease, ambiguous or non-generated releases require explicit manual approval"],
  };
}
export interface WorkflowEvidence {
  id: number;
  run_attempt: number;
  event: string;
  head_sha: string;
  head_branch: string;
  path: string;
  created_at: string;
  status: string;
  conclusion: string | null;
  repository: { full_name: string };
  head_repository: { full_name: string };
}
export interface ExpectedCheck {
  sha: string;
  branch: string;
  event: "push" | "pull_request";
  created?: string;
  merged?: string;
}
export function workflowPassed(runs: WorkflowEvidence[], expected: ExpectedCheck): boolean {
  const eligible = runs.filter(
    (r) =>
      r.repository.full_name === releaseRepository &&
      r.head_repository.full_name === releaseRepository &&
      r.path === ".github/workflows/check.yml" &&
      r.head_sha === expected.sha &&
      r.head_branch === expected.branch &&
      r.event === expected.event &&
      (!expected.created || Date.parse(r.created_at) >= Date.parse(expected.created)) &&
      (!expected.merged || Date.parse(r.created_at) <= Date.parse(expected.merged)),
  );
  const latest = eligible.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  return latest?.status === "completed" && latest.conclusion === "success";
}
export function hasChangelogHeading(text: string, version: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const parts = line.trim().split(/\s+/);
    return parts[0] === "##" && parts[1] === version;
  });
}

export interface BoundaryPull {
  merged_at: string | null;
  base: { ref: string; repo: { full_name: string } };
  labels: { name: string }[];
}
export function allChangesetsAtBoundary(groups: BoundaryPull[][]): boolean {
  return (
    groups.length > 0 &&
    groups.every((pulls) =>
      pulls.some(
        (p) =>
          !!p.merged_at &&
          p.base.ref === "main" &&
          p.base.repo.full_name === releaseRepository &&
          p.labels.some((l) => l.name === "stack:boundary") &&
          p.labels
            .filter((l) => l.name.startsWith("stack:"))
            .every((l) => l.name === "stack:boundary"),
      ),
    )
  );
}
export function hasInstallHook(scripts: Record<string, unknown> | undefined): boolean {
  return ["preinstall", "install", "postinstall"].some(
    (name) => scripts && Object.hasOwn(scripts, name),
  );
}
export function packageFacing(paths: string[]): boolean {
  return paths.some(
    (p) =>
      /^(src\/|bin\/|docs\/|skills\/|agents\/)/.test(p) ||
      [
        "package.json",
        "bun.lock",
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        "scripts/build.ts",
      ].includes(p),
  );
}
export function generatedVersionPr(event: unknown): boolean {
  const p = (
    event as {
      pull_request?: {
        title?: string;
        user?: { login?: string };
        head?: { ref?: string; repo?: { full_name?: string } };
        base?: { ref?: string; repo?: { full_name?: string } };
      };
    } | null
  )?.pull_request;
  return (
    !!p &&
    p.title === "chore(release): version packages" &&
    p.user?.login === "github-actions[bot]" &&
    p.head?.ref === "changeset-release/main" &&
    p.head.repo?.full_name === releaseRepository &&
    p.base?.ref === "main" &&
    p.base.repo?.full_name === releaseRepository
  );
}
export const releaseCiWaitAttempts = 120;
export const releaseCiPollMs = 10000;
