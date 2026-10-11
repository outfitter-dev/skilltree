const HELP = `Skilltree — development scaffold

Usage: bun run dev -- [--help]

Git-backed skill synchronization that preserves local edits is proposed.
Sync, installation, approval, and deployment commands are not implemented.
`;

export function main(args: readonly string[]): number {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    console.log(HELP);
    return 0;
  }

  console.error("Skilltree is a scaffold; only --help is available.");
  return 2;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
