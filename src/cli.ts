import { buildInfo } from "./version";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { execute, type Options } from "./service";
import { SkilltreeError } from "./model";

const HELP = `Skilltree — first release candidate

Usage: skilltree <command> --home <durable-state> [options]
       skilltree --version

init       --dest <shared-library> --exclusive-dest [--gardener <profile>] [--primary <profile>] [--lock-backend mkdir|flock]
           [--adapter filesystem|grok] [--storage <path>] [--runtime-root <path>]
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
backup     [--reason <reason>]         Verify complete directory recovery point
backups                               List verified directory recovery points
revert     --snapshot <id> --expect <reviewed-current-hash> --quiet-host [--dry-run]
configure  [--adapter grok] [--runtime-root <path>] [--storage <path>]
migrate-storage                       Relocate report-recognized legacy backups
compact    --caches | --scratch | --retain-backups <count> | --retained-directories | --backup-scratch [--dry-run]
archive                               Archive intact accepted Git histories
restore                               Materialize verified archives; preserve old checkouts
recover    [--scratch --expect <reviewed-journal-hash>] [--unlock] [--quiet-host] [--keep-current --expect <hash>]                  Explicit transaction/stale-lock recovery
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
  "backup",
  "backups",
  "revert",
  "configure",
  "migrate-storage",
  "compact",
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
        version: { type: "boolean", short: "v" },
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
        adapter: { type: "string" },
        storage: { type: "string" },
        "runtime-root": { type: "string" },
        caches: { type: "boolean" },
        scratch: { type: "boolean" },
        "retain-backups": { type: "string" },
        snapshot: { type: "string" },
        expect: { type: "string" },
        "keep-current": { type: "boolean" },
        "quiet-host": { type: "boolean" },
        "retained-directories": { type: "boolean" },
        "backup-scratch": { type: "boolean" },
      },
    });
    if (values.version) {
      console.log(JSON.stringify(buildInfo()));
      return 0;
    }
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
        "configure",
        "migrate-storage",
        "compact",
        "backup",
        "backups",
        "revert",
      ].includes(command) &&
        positionals.length > 1)
    )
      throw new SkilltreeError("USAGE", "Unexpected positional arguments");
    const options: Options = {};
    for (const name of [
      "snapshot",
      "expect",
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
    if (values["keep-current"] !== undefined) options.keepCurrent = values["keep-current"];
    if (values.adapter !== undefined) {
      if (!["filesystem", "grok"].includes(values.adapter))
        throw new SkilltreeError("USAGE", "Unknown adapter");
      options.adapter = values.adapter as "filesystem" | "grok";
    }
    if (values.storage !== undefined) options.transactionStorage = values.storage;
    if (values["runtime-root"] !== undefined) options.runtimeRoot = values["runtime-root"];
    if (values["quiet-host"] !== undefined) options.quietHost = values["quiet-host"];
    if (values["retained-directories"] !== undefined)
      options.retainedDirectories = values["retained-directories"];
    if (values["backup-scratch"] !== undefined) options.backupScratch = values["backup-scratch"];
    if (values.caches !== undefined) options.caches = values.caches;
    if (values.scratch !== undefined) options.scratch = values.scratch;
    if (values["retain-backups"] !== undefined)
      options.retainBackups = Number(values["retain-backups"]);
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
        events: [
          { version: 1, type: "operation.error", command: args[0] ?? null, code, message },
          ...(error instanceof SkilltreeError ? error.events : []),
        ],
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
