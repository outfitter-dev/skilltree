import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { parse } from "yaml";
import {
  evaluateRelease,
  workflowPassed,
  hasChangelogHeading,
  generatedReleaseTitle,
  versionCiAllowed,
  versionCiTitle,
  allChangesetsAtBoundary,
  hasInstallHook,
  packageFacing,
  generatedVersionPr,
  releaseCiWaitAttempts,
  releaseCiPollMs,
  type BoundaryPull,
  type WorkflowEvidence,
  type Evidence,
} from "../scripts/release-policy";
const valid: Evidence = {
  repository: "outfitter-dev/skilltree",
  ref: "refs/heads/main",
  version: "0.2.0",
  previousVersion: "0.1.0",
  labels: ["publish:auto", "channel:stable", "release:minor"],
  ciPassed: true,
  generatedPr: true,
  botCommit: true,
  versionOnly: true,
  sourceBoundary: true,
  noneReason: false,
};
test("only a reviewed generated stable release qualifies for automatic publication", () => {
  expect(evaluateRelease(valid)).toMatchObject({
    decision: "auto",
    environment: "npm-auto",
    tag: "latest",
  });
  for (const field of ["generatedPr", "botCommit", "versionOnly", "sourceBoundary"] as const)
    expect(evaluateRelease({ ...valid, [field]: false })).toMatchObject({
      decision: "manual",
      environment: "npm",
    });
  expect(evaluateRelease({ ...valid, labels: [] })).toMatchObject({ decision: "manual" });
  expect(evaluateRelease({ ...valid, previousVersion: valid.version })).toMatchObject({
    decision: "manual",
  });
  expect(
    evaluateRelease({ ...valid, labels: ["publish:auto", "channel:stable", "release:patch"] }),
  ).toMatchObject({ decision: "manual" });
});
test("prereleases retain their explicit channel and require the manual environment", () => {
  expect(evaluateRelease({ ...valid, version: "0.1.0-rc.0" })).toMatchObject({
    decision: "manual",
    tag: "rc",
    environment: "npm",
  });
  expect(evaluateRelease({ ...valid, version: "0.2.0-beta.2" })).toMatchObject({
    decision: "manual",
    tag: "beta",
  });
  expect(() => evaluateRelease({ ...valid, version: "0.2.0-surprise.1" })).toThrow(
    "Unsupported release channel",
  );
});
test("wrong contexts, missing exact checks and conflicting intent fail closed", () => {
  for (const change of [
    { repository: "elsewhere/skilltree" },
    { ref: "refs/heads/feature" },
    { ciPassed: false },
    { labels: ["publish:block"] },
    { labels: ["publish:auto", "publish:manual"] },
    { labels: ["publish:unexpected"] },
  ])
    expect(evaluateRelease({ ...valid, ...change })).toMatchObject({ decision: "block" });
  expect(evaluateRelease({ ...valid, labels: ["publish:none"] })).toMatchObject({
    decision: "block",
  });
  expect(evaluateRelease({ ...valid, labels: ["publish:none"], noneReason: true })).toMatchObject({
    decision: "none",
  });
});
test("the published package is portable, public and has no install-time dependencies or hooks", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  expect(pkg.private).not.toBe(true);
  expect(pkg.publishConfig).toEqual({ access: "public", registry: "https://registry.npmjs.org/" });
  expect(pkg.repository.url).toBe("git+https://github.com/outfitter-dev/skilltree.git");
  expect(pkg.dependencies).toBeUndefined();
  expect(hasInstallHook(pkg.scripts)).toBe(false);
  expect(pkg.scripts.prepublishOnly).toBe("node scripts/publish-guard.mjs");
  expect(pkg.files).not.toContain("dist/bin/");
  expect(pkg.files).toContain("dist/cli.mjs");
});
test("release workflow cannot publish from a PR, unreviewed ordinary push or missing gate", () => {
  const workflow = parse(fs.readFileSync(".github/workflows/release.yml", "utf8"));
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
  for (const job of ["version", "policy", "publish"])
    expect(workflow.jobs[job].if).toContain("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.policy.environment).toBeUndefined();
  expect(workflow.jobs.publish.if).toContain("needs.policy.outputs.ready == 'true'");
  expect(workflow.jobs.publish.environment).toBe("${{ needs.policy.outputs.environment }}");
  expect(workflow.jobs.publish.permissions["id-token"]).toBe("write");
  const text = fs.readFileSync(".github/workflows/release.yml", "utf8");
  expect(text).not.toContain("secrets.NPM_TOKEN");
  expect(text).not.toContain("pull_request_target");
  expect(text).not.toContain("--force");
  expect(text).not.toContain("--clobber");
  expect(text).toContain("npm@11.18.0");
  expect(workflow.jobs["github-release"].needs).toContain("registry-smoke");
});

const historic: WorkflowEvidence = {
  id: 10,
  run_attempt: 1,
  event: "pull_request",
  head_sha: "a".repeat(40),
  head_branch: "changeset-release/main",
  path: ".github/workflows/check.yml",
  created_at: "2026-10-01T12:00:00Z",
  status: "completed",
  conclusion: "success",
  repository: { full_name: "outfitter-dev/skilltree" },
  head_repository: { full_name: "outfitter-dev/skilltree" },
};
const expected = {
  sha: historic.head_sha,
  branch: historic.head_branch,
  event: "pull_request" as const,
  created: "2026-10-01T10:00:00Z",
  merged: "2026-10-02T10:00:00Z",
};
test("historical exact-head PR runs remain valid after GitHub clears merged PR associations", () => {
  expect(workflowPassed([historic], expected)).toBe(true);
  for (const change of [
    { event: "workflow_dispatch" },
    { head_sha: "b".repeat(40) },
    { head_branch: "other" },
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "other/project" } },
    { head_repository: { full_name: "fork/project" } },
    { created_at: "2026-09-01T10:00:00Z" },
    { created_at: "2026-10-03T10:00:00Z" },
  ])
    expect(workflowPassed([{ ...historic, ...change }], expected)).toBe(false);
  expect(workflowPassed([historic, { ...historic, id: 11, conclusion: "failure" }], expected)).toBe(
    false,
  );
  expect(
    workflowPassed(
      [historic, { ...historic, run_attempt: 2, status: "in_progress", conclusion: null }],
      expected,
    ),
  ).toBe(false);
});
test("changelog evidence must name the exact release heading", () => {
  expect(hasChangelogHeading("# History\n\n## 0.1.0-rc.1\nDetails", "0.1.0-rc.1")).toBe(true);
  expect(hasChangelogHeading("## 0.1.0-rc.10", "0.1.0-rc.1")).toBe(false);
  expect(hasChangelogHeading("text mentions 0.1.0", "0.1.0")).toBe(false);
});

test("every consumed changeset needs an associated merged boundary PR", () => {
  const pr: BoundaryPull = {
    merged_at: "2026-10-01T12:00:00Z",
    base: { ref: "main", repo: { full_name: "outfitter-dev/skilltree" } },
    labels: [{ name: "stack:boundary" }],
  };
  expect(allChangesetsAtBoundary([[pr], [pr]])).toBe(true);
  expect(allChangesetsAtBoundary([[pr, { ...pr, merged_at: null }], [pr]])).toBe(true);
  for (const groups of [
    [],
    [[]],
    [[pr], []],
    [[pr], [{ ...pr, labels: [] }]],
    [[pr], [{ ...pr, merged_at: null }]],
    [[pr], [{ ...pr, base: { ...pr.base, ref: "other" } }]],
    [[pr], [{ ...pr, base: { ...pr.base, repo: { full_name: "other/skilltree" } } }]],
    [[{ ...pr, labels: [...pr.labels, { name: "stack:part" }] }]],
  ])
    expect(allChangesetsAtBoundary(groups)).toBe(false);
});
test("all npm install lifecycle hooks are rejected", () => {
  expect(hasInstallHook(undefined)).toBe(false);
  expect(hasInstallHook({ prepublishOnly: "node scripts/publish-guard.mjs" })).toBe(false);
  for (const name of [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
  ])
    expect(hasInstallHook({ [name]: "echo example" })).toBe(true);
});
test("all public payload paths require release intent", () => {
  for (const path of [
    "src/cli.ts",
    "bin/skilltree.mjs",
    "docs/releases.md",
    "skills/helper/SKILL.md",
    "agents/gardener.md",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "package.json",
    "scripts/build.ts",
  ])
    expect(packageFacing([path])).toBe(true);
  expect(packageFacing(["tests/release.test.ts", ".github/workflows/check.yml"])).toBe(false);
});
test("a version-like fork or human branch cannot bypass changeset checks", () => {
  const pr = {
    title: "chore(release): version packages",
    user: { login: "github-actions[bot]" },
    head: { ref: "changeset-release/main", repo: { full_name: "outfitter-dev/skilltree" } },
    base: { ref: "main", repo: { full_name: "outfitter-dev/skilltree" } },
  };
  expect(generatedVersionPr({ pull_request: pr })).toBe(true);
  expect(
    generatedVersionPr({
      pull_request: { ...pr, head: { ...pr.head, repo: { full_name: "fork/skilltree" } } },
    }),
  ).toBe(false);
  expect(generatedVersionPr({ pull_request: { ...pr, user: { login: "someone" } } })).toBe(false);
  expect(generatedVersionPr({ pull_request: { ...pr, base: { ...pr.base, ref: "other" } } })).toBe(
    false,
  );
  expect(generatedVersionPr({})).toBe(false);
});
test("release policy wait covers CI timeout and a scheduling margin", () => {
  const check = parse(fs.readFileSync(".github/workflows/check.yml", "utf8"));
  expect(releaseCiWaitAttempts * releaseCiPollMs).toBeGreaterThanOrEqual(
    (check.jobs["linux-node20"]["timeout-minutes"] + 5) * 60000,
  );
});

test("generated release titles accept only the configured Changesets title and known channels", () => {
  for (const title of [
    "chore(release): version packages",
    "chore(release): version packages (rc)",
    "chore(release): version packages (beta)",
  ])
    expect(generatedReleaseTitle(title)).toBe(true);
  for (const title of [
    "chore(release): version packages extra",
    "chore(release): version packages (surprise)",
    "chore(release): version packages (rc) extra",
    null,
  ])
    expect(generatedReleaseTitle(title)).toBe(false);
});
test("version dispatch validates the actual open bot PR and a frozen exact head", () => {
  const sha = "a".repeat(40);
  const pr = {
    state: "open",
    title: "chore(release): version packages (rc)",
    user: { login: "github-actions[bot]" },
    head: { sha, ref: "changeset-release/main", repo: { full_name: "outfitter-dev/skilltree" } },
    base: { ref: "main", repo: { full_name: "outfitter-dev/skilltree" } },
  };
  const context = {
    repository: "outfitter-dev/skilltree",
    ref: "refs/heads/changeset-release/main",
    event: "workflow_dispatch",
    sha,
    expectedSha: sha,
  };
  expect(versionCiAllowed(context, pr)).toBe(true);
  for (const changed of [
    { repository: "other/project" },
    { ref: "refs/heads/main" },
    { event: "pull_request" },
    { expectedSha: "b".repeat(40) },
    { sha: "invalid" },
  ])
    expect(versionCiAllowed({ ...context, ...changed }, pr)).toBe(false);
  for (const changed of [
    { state: "closed" },
    { user: { login: "someone" } },
    { head: { ...pr.head, sha: "b".repeat(40) } },
    { head: { ...pr.head, repo: { full_name: "fork/skilltree" } } },
  ])
    expect(versionCiAllowed(context, { ...pr, ...changed })).toBe(false);
});
test("only named exact generated-PR dispatches qualify; newest failure still holds", () => {
  const versionExpected = { ...expected, versionPr: 4 };
  const dispatch = {
    ...historic,
    id: 12,
    event: "workflow_dispatch",
    display_title: versionCiTitle(4, historic.head_sha),
  };
  expect(workflowPassed([dispatch], versionExpected)).toBe(true);
  expect(workflowPassed([dispatch], expected)).toBe(false);
  for (const title of [
    "Skilltree checks",
    versionCiTitle(5, historic.head_sha),
    versionCiTitle(4, "b".repeat(40)),
  ])
    expect(workflowPassed([{ ...dispatch, display_title: title }], versionExpected)).toBe(false);
  expect(
    workflowPassed([dispatch, { ...historic, id: 13, conclusion: "failure" }], versionExpected),
  ).toBe(false);
  expect(
    workflowPassed(
      [historic, { ...dispatch, status: "in_progress", conclusion: null }],
      versionExpected,
    ),
  ).toBe(false);
  expect(
    workflowPassed([{ ...dispatch, head_branch: "main" }], {
      ...versionExpected,
      branch: "main",
      event: "push",
    }),
  ).toBe(false);
});
test("generated version checks use a scoped read-only dispatch without a new credential", () => {
  const check = parse(fs.readFileSync(".github/workflows/check.yml", "utf8"));
  const release = parse(fs.readFileSync(".github/workflows/release.yml", "utf8"));
  expect(check.permissions).toEqual({ contents: "read", "pull-requests": "read" });
  expect(check.on.workflow_dispatch.inputs.version_pr.type).toBe("string");
  expect(check.on.workflow_dispatch.inputs.version_sha.type).toBe("string");
  expect(check["run-name"]).toContain("Skilltree version PR {0} {1}");
  const guard = check.jobs["linux-node20"].steps.find(
    (s: { run?: string }) => s.run === "bun scripts/version-ci.ts",
  );
  expect(guard.if).toContain("github.ref == 'refs/heads/changeset-release/main'");
  expect(release.jobs.version.permissions.actions).toBe("write");
  expect(release.jobs.publish.if).toContain("github.ref == 'refs/heads/main'");
});

test("latest execution governs reruns across PR and dispatched checks", () => {
  const versionExpected = { ...expected, versionPr: 4 };
  const first = {
    ...historic,
    run_started_at: "2026-10-01T12:00:00Z",
    updated_at: "2026-10-01T12:02:00Z",
  };
  const newerFailure = {
    ...historic,
    id: 13,
    event: "workflow_dispatch",
    display_title: versionCiTitle(4, historic.head_sha),
    run_started_at: "2026-10-01T12:10:00Z",
    updated_at: "2026-10-01T12:12:00Z",
    conclusion: "failure",
  };
  const rerun = {
    ...first,
    run_attempt: 2,
    run_started_at: "2026-10-01T12:20:00Z",
    updated_at: "2026-10-01T12:22:00Z",
  };
  expect(workflowPassed([newerFailure, rerun], versionExpected)).toBe(true);
  expect(
    workflowPassed(
      [newerFailure, { ...rerun, status: "queued", conclusion: null }],
      versionExpected,
    ),
  ).toBe(false);
  expect(
    workflowPassed(
      [newerFailure, { ...rerun, status: "in_progress", conclusion: null }],
      versionExpected,
    ),
  ).toBe(false);
  expect(
    workflowPassed(
      [newerFailure, { ...first, updated_at: "2026-10-01T12:30:00Z" }],
      versionExpected,
    ),
  ).toBe(false);
  expect(
    workflowPassed(
      [
        { ...newerFailure, status: "in_progress", conclusion: null },
        { ...first, updated_at: "2026-10-01T12:30:00Z" },
      ],
      versionExpected,
    ),
  ).toBe(false);
  expect(workflowPassed([{ ...newerFailure, event: "pull_request" }, rerun], expected)).toBe(true);
});
