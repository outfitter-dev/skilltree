import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("help describes the scaffold without claiming implemented sync", async () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = await run(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not implemented");
    expect(result.stderr).toBe("");
  }
});

test("unimplemented commands fail explicitly", async () => {
  for (const args of [["sync"], ["--help", "sync"]]) {
    const result = await run(args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("only --help is available");
  }
});
