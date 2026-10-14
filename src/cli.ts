import { buildInfo } from "./version";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import { join } from "node:path";
import { execute, type Options } from "./service";
import { SkilltreeError, fail } from "./model";
import { assertNoSymlinks, exists } from "./files";
import { canonicalCommand, checkedId, deprecated, parseCommand, stateHome } from "./command-input";

const usage: Record<string, string> = {
  init: "init <name> [--dry-run]  Scaffold a new <name>/SKILL.md; refuses existing paths",
  setup:
    "setup --dest <shared-library> --exclusive-dest [--adapter filesystem|grok] [--storage <path>] [--runtime-root <path>] [--lock-backend mkdir|flock]",
  add: "add <local-git-directory|owner/repo[@skill]|https-url> [--source <id>] [--ref <ref>] [--skill|-s <names...>|--all] [--list|-l] [--full-depth] [--id <single-destination-id>] [--yes|-y|--install --reason <request>]",
  remove:
    "remove [source-or-skill...] [--source <id>|--skill|-s <ids...>|--all] [--force] [--yes|-y --reason <review>]  Stages reversible removals; force never bypasses apply gates",
  list: "list [--profile|-a <profile>] [--json]  Filter shared metadata; profiles do not isolate access",
  plan: "plan [ids...] [--yes|-y --reason <review>]  Fetch/reconcile/stage only by default; prints exact candidate hashes",
  apply:
    "apply <id> --hash <candidate-hash> [--reason <review>]  Approve and deploy; reason may be omitted only after legacy approve",
  snapshot:
    "snapshot <id> | snapshot --backup [--reason <reason>] | snapshot list | snapshot restore <id> --expect <reviewed-current-hash> --quiet-host [--dry-run]",
  assign: "assign <id> --profile <profile>",
  status: "status [--profile <profile>]",
  verify: "verify [--profile <profile>]",
  doctor: "doctor  Read-only filesystem, state and backup diagnostics",
  configure: "configure [--adapter grok] [--runtime-root <path>] [--storage <path>]",
  "migrate-storage": "migrate-storage [--dry-run]",
  compact:
    "compact --caches | --scratch | --retain-backups <count> | --retained-directories | --backup-scratch [--dry-run]",
  archive: "archive [--dry-run]",
  restore: "restore [--dry-run]  Materialize state archives; preserve old checkouts",
  probe:
    "probe <source-id> [--npx <executable>]  Optional pinned skills CLI listing (Node >=22.20)",
};
const legacyUsage: Record<string, string> = {
  select: "select <source-id> --path <exact-path> --id <id> [--install --reason <request>]",
  inventory: "inventory <source-id>",
  sync: "sync",
  approve: "approve <id> --hash <hash> --reason <review>",
  capture: "capture <id>",
  backup: "backup [--reason <reason>]",
  backups: "backups",
  revert: "revert --snapshot <id> --expect <reviewed-current-hash> --quiet-host [--dry-run]",
  recover:
    "recover [--scratch --expect <journal-hash>] [--unlock] [--quiet-host] [--keep-current --expect <hash>] [--dry-run]",
};
const HELP = `Skilltree — guarded shared skill library

Usage: skilltree <command> [--home <durable-state>] [options]
       skilltree --version | -v | <command> --help

${Object.values(usage).join("\n")}

Aliases: a=add, ls=list, rm=remove, update/upgrade=plan.
Legacy commands until 0.2: select, inventory, init --dest, sync, approve, capture, backup, backups, revert.
Home: explicit --home, then SKILLTREE_HOME, then Grok adapter default /workspace/skilltree.
Output is JSON. --json is accepted. Agent/scope compatibility flags warn on stderr.
--all selects only. Activation requires --yes/--install plus --reason, or apply with an exact hash.
All state-writing commands accept --dry-run; no authoritative state is changed.
Every live write needs a verified complete-library backup and unchanged ownership/drift baselines.
Git is required. Filesystem deployment needs coordinated exclusive access.
Grok host writes and catalog refresh are not verified integrations.
`;
function scaffold(name: string | undefined, dryRun: boolean): unknown {
  if (!name) fail("USAGE", "init requires a new skill name; use setup --dest for library state");
  checkedId(name, "Skill name");
  const root = assertNoSymlinks(join(process.cwd(), name));
  if (exists(root)) fail("EXISTS", "Skill scaffold path already exists; preserve it");
  if (!dryRun) {
    fs.mkdirSync(root);
    fs.writeFileSync(
      join(root, "SKILL.md"),
      `---\nname: ${name}\ndescription: Describe when this skill should be used.\n---\n\n# ${name}\n\nAdd the skill instructions here.\n`,
      { flag: "wx" },
    );
  }
  return { outcome: dryRun ? "WOULD_SCAFFOLD" : "SCAFFOLDED", path: join(root, "SKILL.md") };
}
export function main(args: string[]): number {
  try {
    const { values, positionals, warnings } = parseCommand(args);
    const str = (name: string) =>
      typeof values[name] === "string" ? (values[name] as string) : undefined;
    const bool = (name: string) => values[name] === true;
    if (bool("version")) {
      console.log(JSON.stringify(buildInfo()));
      return 0;
    }
    let command = canonicalCommand(positionals[0] ?? "");
    let operands = positionals.slice(1);
    if (command === "help") {
      command = canonicalCommand(operands[0] ?? "");
      operands = [];
      values.help = true;
    }
    if (bool("help") || !command) {
      if (command && !Object.hasOwn(usage, command) && !Object.hasOwn(legacyUsage, command))
        fail("USAGE", "Unknown command");
      console.log(
        command
          ? `Usage: skilltree ${usage[command] ?? legacyUsage[command]}\n\n${HELP.slice(HELP.indexOf("Home:"))}`
          : HELP,
      );
      return 0;
    }
    if (!Object.hasOwn(usage, command) && !Object.hasOwn(legacyUsage, command))
      fail("USAGE", "Unknown command; see --help");
    for (const warning of warnings) console.error(`Warning: ${warning}`);
    if (Object.hasOwn(deprecated, command))
      console.error(`Deprecated until 0.2: ${command}; use ${deprecated[command]}`);
    if (command === "init" && str("dest")) {
      console.error("Deprecated until 0.2: init --dest; use setup");
      command = "setup";
    }
    if (
      !["plan", "remove", "snapshot"].includes(command) &&
      operands.length >
        ([
          "setup",
          "list",
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
          "sync",
        ].includes(command)
          ? 0
          : 1)
    )
      fail("USAGE", "Unexpected positional arguments");
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
      if (str(name) !== undefined) options[name] = str(name)!;
    const mapping = {
      "keep-current": "keepCurrent",
      "quiet-host": "quietHost",
      "retained-directories": "retainedDirectories",
      "backup-scratch": "backupScratch",
      caches: "caches",
      scratch: "scratch",
      "host-metadata": "hostMetadata",
      install: "install",
      yes: "yes",
      all: "all",
      force: "force",
      "full-depth": "fullDepth",
      "dry-run": "dryRun",
      "exclusive-dest": "exclusive",
      unlock: "unlock",
      list: "list",
    } as const;
    for (const [flag, property] of Object.entries(mapping))
      if (values[flag] !== undefined)
        options[property as (typeof mapping)[keyof typeof mapping]] = bool(flag);
    if (values.skill) options.skills = values.skill as string[];
    if (str("lock-backend")) {
      if (!["mkdir", "flock"].includes(str("lock-backend")!)) fail("USAGE", "Unknown lock backend");
      options.lockBackend = str("lock-backend") as "mkdir" | "flock";
    }
    if (str("adapter")) {
      if (!["filesystem", "grok"].includes(str("adapter")!)) fail("USAGE", "Unknown adapter");
      options.adapter = str("adapter") as "filesystem" | "grok";
    }
    if (str("storage")) options.transactionStorage = str("storage")!;
    if (str("runtime-root")) options.runtimeRoot = str("runtime-root")!;
    if (str("dest")) options.destination = str("dest")!;
    if (str("retain-backups")) options.retainBackups = Number(str("retain-backups"));
    if (command === "snapshot") {
      if (operands[0] === "list") {
        if (operands.length !== 1 || bool("backup")) fail("USAGE", "snapshot list takes no IDs");
        command = "backups";
        operands = [];
      } else if (operands[0] === "restore") {
        if (operands.length !== 2 || bool("backup"))
          fail("USAGE", "snapshot restore requires one recovery point ID");
        options.snapshot = operands[1]!;
        command = "revert";
        operands = [];
      } else if (bool("backup")) {
        if (operands.length) fail("USAGE", "snapshot --backup takes no skill IDs");
        command = "backup";
      } else {
        if (operands.length !== 1)
          fail(
            "USAGE",
            "snapshot requires a skill ID or an explicit backup/list/restore operation",
          );
        command = "capture";
      }
    }
    const result =
      command === "init"
        ? scaffold(operands[0], bool("dry-run"))
        : execute(stateHome(str("home")), command, operands, options);
    console.log(JSON.stringify(result, null, 2));
    const output = result as { outcome?: string; result?: { outcome?: string } };
    return ["DRIFT", "ERROR", "PARTIAL"].includes(output.outcome ?? output.result?.outcome ?? "")
      ? 1
      : 0;
  } catch (error) {
    const code = error instanceof SkilltreeError ? error.code : "ERROR";
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
