import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fail } from "./model";
import { gitEnvironment } from "./git";

// Replaceable, listing-only subprocess boundary. Never point an installer at a live library.
export function probeSkills(sourceRoot: string, npx = "npx"): { adapter: string; output: string } {
  const [major, minor] = execFileSync("node", ["--version"], { encoding: "utf8" })
    .trim()
    .slice(1)
    .split(".")
    .map(Number);
  if (!major || major < 22 || (major === 22 && (minor ?? 0) < 20))
    fail(
      "ADAPTER_RUNTIME",
      "skills@1.7.2 requires Node >=22.20; native inventory works without it",
    );
  const scratch = fs.mkdtempSync(join(tmpdir(), "skilltree-skills-probe-"));
  try {
    const output = execFileSync(
      npx,
      ["--yes", "--package=skills@1.7.2", "skills", "add", sourceRoot, "--list"],
      {
        cwd: scratch,
        env: {
          ...gitEnvironment(),
          npm_config_cache: join(scratch, "npm"),
          XDG_CONFIG_HOME: join(scratch, "config"),
          XDG_DATA_HOME: join(scratch, "data"),
          XDG_STATE_HOME: join(scratch, "state"),
          DISABLE_TELEMETRY: "1",
          CI: "1",
        },
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 2_000_000,
      },
    );
    return { adapter: "skills@1.7.2 (listing only)", output };
  } finally {
    fs.rmSync(scratch, { recursive: true });
  }
}
