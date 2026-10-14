import { fail, slug } from "./model";

export const aliases: Record<string, string> = {
  a: "add",
  ls: "list",
  update: "plan",
  upgrade: "plan",
  rm: "remove",
};
export function canonicalCommand(name: string): string {
  return Object.hasOwn(aliases, name) ? aliases[name]! : name;
}
export const deprecated: Record<string, string> = {
  select: "add --skill",
  inventory: "add --list",
  sync: "plan",
  approve: "apply --reason",
  capture: "snapshot",
  backup: "snapshot --backup",
  backups: "snapshot list",
  revert: "snapshot restore",
};
const strings = new Set([
  "home",
  "dest",
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
  "lock-backend",
  "adapter",
  "storage",
  "runtime-root",
  "retain-backups",
  "snapshot",
  "expect",
]);
const booleans = new Set([
  "help",
  "version",
  "install",
  "yes",
  "all",
  "list",
  "json",
  "full-depth",
  "force",
  "backup",
  "dry-run",
  "exclusive-dest",
  "unlock",
  "host-metadata",
  "caches",
  "scratch",
  "keep-current",
  "quiet-host",
  "retained-directories",
  "backup-scratch",
]);
const ignoredBoolean = new Set(["global", "project", "copy"]);
const ignoredMulti = new Set(["agent", "agents", "subagent"]);
const short: Record<string, string> = {
  h: "help",
  v: "version",
  s: "skill",
  l: "list",
  y: "yes",
  g: "global",
  p: "project",
};

export function parseCommand(args: string[]) {
  const values: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  const warnings: string[] = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (literal || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    const [flag, inline] = arg.replace(/^--?/, "").split(/=(.*)/s);
    const command = canonicalCommand(positionals[0] ?? "");
    const name =
      flag === "a" ? (command === "list" ? "profile" : "agent") : (short[flag!] ?? flag!);
    const many = name === "skill" || ignoredMulti.has(name);
    if (many) {
      const items = inline === undefined ? [] : [inline];
      while (i + 1 < args.length && !args[i + 1]!.startsWith("-")) items.push(args[++i]!);
      if (!items.length || items.some((v) => !v)) fail("USAGE", `--${name} requires a value`);
      if (name === "skill") values.skill = [...((values.skill as string[]) ?? []), ...items];
      else
        warnings.push(
          `Ignoring --${name}; Skilltree uses one shared library (use --profile for metadata)`,
        );
    } else if (strings.has(name) || name === "metadata") {
      const value = inline ?? args[++i];
      if (!value || value.startsWith("-")) fail("USAGE", `--${name} requires a value`);
      if (name === "metadata") warnings.push("Ignoring --metadata; telemetry metadata is not used");
      else {
        if (values[name] !== undefined) fail("USAGE", `Repeated --${name}`);
        values[name] = value;
      }
    } else if (booleans.has(name) || ignoredBoolean.has(name)) {
      if (inline !== undefined) fail("USAGE", `--${name} does not take a value`);
      if (ignoredBoolean.has(name))
        warnings.push(`Ignoring --${name}; Skilltree uses one shared library`);
      else values[name] = true;
    } else fail("USAGE", `Unknown option --${name}`);
  }
  return { values, positionals, warnings };
}
export function stateHome(explicit?: string): string {
  const home = explicit ?? process.env.SKILLTREE_HOME ?? "/workspace/skilltree";
  if (!home.trim()) fail("USAGE", "State home must not be empty");
  return home;
}
export function checkedId(value: string, label = "ID"): string {
  if (!slug.safeParse(value).success)
    fail(
      "USAGE",
      `${label} must use lowercase letters, digits, underscores or hyphens (maximum 64 characters)`,
    );
  return value;
}
