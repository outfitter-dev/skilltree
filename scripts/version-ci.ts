import { execFileSync } from "node:child_process";
import { releaseRepository, versionCiAllowed } from "./release-policy";
try {
  const number = process.env.SKILLTREE_VERSION_PR ?? "";
  if (!/^[1-9][0-9]*$/.test(number))
    throw new Error("Generated version checks require an explicit PR number");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (sha !== process.env.GITHUB_SHA) throw new Error("Checkout differs from the dispatched SHA");
  const pr = JSON.parse(
    execFileSync("gh", ["api", "repos/" + releaseRepository + "/pulls/" + number], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (
    !versionCiAllowed(
      {
        repository: process.env.GITHUB_REPOSITORY ?? "",
        ref: process.env.GITHUB_REF ?? "",
        event: process.env.GITHUB_EVENT_NAME ?? "",
        sha,
        expectedSha: process.env.SKILLTREE_VERSION_SHA ?? "",
      },
      pr,
    )
  )
    throw new Error("Dispatched checks require the exact open bot version PR in this repository");
  console.log("Verified generated version PR #" + number + " at " + sha);
} catch (error) {
  console.error(
    error instanceof Error && error.message.startsWith("Dispatched checks")
      ? error.message
      : "Generated version CI identity validation failed",
  );
  process.exitCode = 1;
}
