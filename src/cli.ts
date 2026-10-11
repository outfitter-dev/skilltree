import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { execute, type Options } from "./service";
import { SkilltreeError } from "./model";

const HELP = `Skilltree — first release candidate

Usage: skilltree <command> --home <durable-state> [options]

init       --dest <shared-library> --exclusive-dest [--gardener <profile>] [--primary <profile>] [--lock-backend mkdir|flock]
add        <local-git-directory|owner/repo|https-url> --source <id> [--ref <ref>]
inventory  <source-id>                 List normalized source projections
select     <source-id> --path <skill-path> --id <destination-id> [--profile <profile>]
           [--install --reason <explicit-request>]  Approve and apply this installation
assign     <id> --profile <profile>    Add shared-library profile assignment
list       [--profile <profile>]       Filter metadata; does not isolate access
sync                                  Fetch/reconcile/stage only; never auto-approve or apply
capture    <id>                        Adopt live edits into local Git history
approve    <id> --hash <hash> --reason <review>
apply      <id> --hash <hash>           Apply an exact approved candidate
status | verify | doctor              Read-only state, drift and diagnostics
archive                               Archive intact accepted Git histories
restore                               Materialize verified archives; preserve old checkouts
recover    [--unlock]                  Explicit transaction/stale-lock recovery
probe      <source-id> [--npx <executable>]  Optional pinned skills CLI listing (Node >=22.20)

All state-writing commands accept --dry-run; no authoritative state is changed.
Output is JSON. Git is required. Filesystem deployment needs coordinated exclusive access.
Grok host writes and catalog refresh are not verified integrations.
`;
const commands = new Set([
  "init",
  "add",
  "inventory",
  "select",
  "assign",
  "list",
  "sync",
  "capture",
  "approve",
  "apply",
  "status",
  "verify",
  "doctor",
  "archive",
  "restore",
  "recover",
  "probe",
]);
export function main(args: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        home: { type: "string" },
        dest: { type: "string" },
        source: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
        id: { type: "string" },
        profile: { type: "string" },
        install: { type: "boolean" },
        reason: { type: "string" },
        hash: { type: "string" },
        "dry-run": { type: "boolean" },
        "exclusive-dest": { type: "boolean" },
        primary: { type: "string" },
        gardener: { type: "string" },
        unlock: { type: "boolean" },
        npx: { type: "string" },
        "lock-backend": { type: "string" },
        "host-metadata": { type: "boolean" },
      },
    });
    if (values.help || positionals.length === 0) {
      console.log(HELP);
      return 0;
    }
    const command = positionals[0]!;
    if (!commands.has(command) || !values.home)
      throw new SkilltreeError("USAGE", "Use a documented command and explicit --home; see --help");
    if (
      positionals.length > 2 ||
      ([
        "init",
        "list",
        "sync",
        "status",
        "verify",
        "doctor",
        "recover",
        "archive",
        "restore",
      ].includes(command) &&
        positionals.length > 1)
    )
      throw new SkilltreeError("USAGE", "Unexpected positional arguments");
    const options: Options = {};
    for (const name of [
      "source",
      "ref",
      "path",
      "id",
      "profile",
      "reason",
      "hash",
      "primary",
      "gardener",
      "npx",
    ] as const)
      if (values[name] !== undefined) options[name] = values[name];
    if (values["lock-backend"] !== undefined) {
      if (!["mkdir", "flock"].includes(values["lock-backend"]))
        throw new SkilltreeError("USAGE", "Unknown lock backend");
      options.lockBackend = values["lock-backend"] as "mkdir" | "flock";
    }
    if (values["host-metadata"] !== undefined) options.hostMetadata = values["host-metadata"];
    if (values.dest !== undefined) options.destination = values.dest;
    if (values.install !== undefined) options.install = values.install;
    if (values.unlock !== undefined) options.unlock = values.unlock;
    if (values["dry-run"] !== undefined) options.dryRun = values["dry-run"];
    if (values["exclusive-dest"] !== undefined) options.exclusive = values["exclusive-dest"];
    const result = execute(values.home, command, positionals.slice(1), options);
    console.log(JSON.stringify(result, null, 2));
    const output = result as { outcome?: string; result?: { outcome?: string } };
    const outcome = output.outcome ?? output.result?.outcome;
    return outcome === "DRIFT" || outcome === "ERROR" || outcome === "PARTIAL" ? 1 : 0;
  } catch (error) {
    const code = error instanceof SkilltreeError ? error.code : "ERROR";
    // Do not echo subprocess stderr, credentials, or arbitrary source data.
    const message =
      error instanceof SkilltreeError
        ? error.message
        : "Validation or operation failed; inspect state and run doctor";
    console.error(
      JSON.stringify({
        outcome: code,
        message,
        events: [{ version: 1, type: "operation.error", command: args[0] ?? null, code, message }],
      }),
    );
    return code === "USAGE" ? 2 : 1;
  }
}
if (
  import.meta.main ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
)
  process.exitCode = main(process.argv.slice(2));
