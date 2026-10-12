import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
test("help describes the lifecycle and limits", async () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = await run(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sync");
    expect(result.stdout).toContain("catalog refresh are not verified");
    expect(result.stderr).toBe("");
  }
});
test("invalid command, unknown flags, and missing state fail without executing", async () => {
  for (const args of [["invented"], ["sync"], ["sync", "--home", "/nonexistent", "--typo"]]) {
    const result = await run(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).outcome).toBeDefined();
  }
});

test("version identifies the runner without requiring state", async () => {
  const result = await run(["--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const info = JSON.parse(result.stdout);
  expect(info.name).toBe("@outfitter/skilltree");
  expect(info.version).toBe("0.1.0-rc.0");
  expect(info.revision).toBeDefined();
  expect(info.sourceHash).toMatch(/^[a-f0-9]{64}$/);
});
