import { basename } from "node:path";
import { createHash } from "node:crypto";
import { fail, type Entry, type Source } from "./model";
import { checkedId } from "./command-input";
import type { Discovery, Skill } from "./discovery";

export function qualifiedRepository(value: string): { repository: string; skill?: string } {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^@]+)$/.exec(value);
  return match ? { repository: match[1]!, skill: match[2]! } : { repository: value };
}
export function sourceId(repo: string): string {
  const name = repo.startsWith("https://")
    ? new URL(repo).pathname.replace(/^\//, "")
    : repo.startsWith("/")
      ? basename(repo)
      : repo;
  const value = name
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!value) fail("USAGE", "Source needs an explicit --source ID");
  return checkedId(
    value.length <= 64
      ? value
      : value.slice(0, 50) + "-" + createHash("sha256").update(repo).digest("hex").slice(0, 12),
    "Source ID",
  );
}
export function skillId(name: string): string {
  return checkedId(name.toLowerCase(), "Skill destination ID; use --id for a single custom name");
}
export function chooseSkills(inventory: Discovery, names: string[], repo: string): Skill[] {
  const requested = names.includes("*") ? [...new Set(inventory.skills.map((s) => s.name))] : names;
  const selected = new Map<string, Skill>();
  for (const raw of requested) {
    const qualified = qualifiedRepository(raw);
    if (qualified.skill && sourceId(qualified.repository) !== sourceId(repo))
      fail("NOT_FOUND", "Qualified skill belongs to a different repository");
    const name = qualified.skill ?? raw;
    const matches = inventory.skills.filter((s) => s.name === name || s.path === name);
    if (matches.length > 1)
      fail(
        "AMBIGUOUS",
        `Skill ${name} has multiple projections; use an exact --skill path or legacy select --path`,
      );
    if (!matches.length)
      fail(
        "NOT_FOUND",
        `Skill ${name} is not available in the supported inventory; inspect add --list holds`,
      );
    selected.set(matches[0]!.path, matches[0]!);
  }
  if (names.length && !selected.size) fail("NOT_FOUND", "No supported skills matched");
  return [...selected.values()];
}
export function selectedIds(entries: Entry[], sources: Source[], names: string[]): Set<string> {
  const ids = new Set<string>();
  for (const name of names) {
    const qualified = qualifiedRepository(name);
    const matches = entries.filter((e) =>
      qualified.skill
        ? (e.name === qualified.skill || e.id === qualified.skill) &&
          sources.some(
            (s) => s.id === e.source && sourceId(s.repository) === sourceId(qualified.repository),
          )
        : e.id === name || e.name === name,
    );
    if (matches.length > 1)
      fail("AMBIGUOUS", `Selection ${name} is ambiguous; use an exact ID or owner/repo@skill`);
    if (!matches.length) fail("NOT_FOUND", `Unknown selection ${name}`);
    ids.add(matches[0]!.id);
  }
  return ids;
}
