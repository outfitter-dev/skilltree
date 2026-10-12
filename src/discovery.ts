import * as fs from "node:fs";
import { join, relative, resolve, dirname, posix } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { fail, relativePath, type Tree } from "./model";
import { assertNoSymlinks, exists, inside, readTree, treeHash } from "./files";

export interface Skill {
  path: string;
  name: string;
  description: string;
  format: string;
  hash: string;
  equivalentPaths: string[];
  ambiguous: boolean;
}
export function metadata(root: string): { name: string; description: string } {
  return metadataTree(readTree(root));
}
export function metadataTree(tree: Tree): { name: string; description: string } {
  const text = Buffer.from(tree["SKILL.md"]!.data, "base64").toString("utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) fail("INVALID_SKILL", "SKILL.md requires YAML name and description frontmatter");
  const doc = parseDocument(match[1]!, { uniqueKeys: true });
  if (doc.errors.length) fail("INVALID_SKILL", "Invalid or duplicate YAML frontmatter keys");
  const frontmatter = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
  if (frontmatter.dependencies || frontmatter.requires)
    fail("UNSUPPORTED_DEPENDENCY", "External dependency declarations need a verified adapter");
  for (const [path, file] of Object.entries(tree)) {
    if (!path.endsWith(".md")) continue;
    const body = Buffer.from(file.data, "base64").toString("utf8");
    for (const match of body.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const raw = match[1]!;
      if (raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      let link: string;
      try {
        link = decodeURIComponent(raw.split("#")[0]!);
      } catch {
        return fail("INVALID_REFERENCE", "Malformed local reference");
      }
      const target = posix.normalize(posix.join(dirname(path), link));
      if (!link || !tree[target] || link.startsWith("/") || target.startsWith("../"))
        fail(
          "MISSING_REFERENCE",
          `Local reference is outside the complete skill file set: ${path}`,
        );
    }
  }
  return z
    .object({ name: z.string().min(1).max(200), description: z.string().min(1).max(4000) })
    .parse(frontmatter);
}
export function discover(root: string): Skill[] {
  assertNoSymlinks(root);
  for (const unsupported of [
    ".cursor-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".chatgpt-plugin/plugin.json",
  ]) {
    if (exists(join(root, unsupported)))
      fail(
        "UNSUPPORTED_FORMAT",
        `${unsupported} requires an adapter whose manifest semantics have been verified`,
      );
  }
  const found = new Map<string, Skill>();
  function scan(dir: string, format: string) {
    if (!exists(dir)) return;
    assertNoSymlinks(dir);
    if (!inside(root, dir)) fail("UNSAFE_PATH", "Plugin skill path escapes source");
    if (exists(join(dir, "SKILL.md"))) {
      const path = relativePath.parse(relative(root, dir));
      if (!found.has(path)) {
        const meta = metadata(dir);
        found.set(path, {
          path,
          ...meta,
          format,
          hash: treeHash(readTree(dir)),
          equivalentPaths: [],
          ambiguous: false,
        });
      }
      return;
    }
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) fail("UNSAFE_TREE", "Symlink in skill discovery tree");
      if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name))
        scan(join(dir, entry.name), format);
    }
  }
  for (const path of [".agents/skills", ".claude/skills", "skills"])
    scan(join(root, path), "plain");
  const plugin = join(root, ".claude-plugin/plugin.json");
  if (exists(plugin)) {
    assertNoSymlinks(plugin);
    const config = z
      .object({ skills: z.array(z.string()).optional() })
      .parse(JSON.parse(fs.readFileSync(plugin, "utf8")));
    for (const path of config.skills ?? ["./skills"]) {
      if (!path.startsWith("./")) fail("INVALID_PLUGIN", "Claude skill paths must start with ./");
      const target = resolve(root, relativePath.parse(path.slice(2)));
      if (!inside(root, target)) fail("UNSAFE_PATH", "Plugin skill path escapes source");
      scan(target, "claude-plugin");
    }
  }
  if (exists(join(root, ".claude-plugin/marketplace.json")))
    fail(
      "UNSUPPORTED_FORMAT",
      "Marketplace ingestion is deferred; add individual plugin repositories",
    );
  const skills = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const skill of skills) {
    const peers = skills.filter((other) => other.name === skill.name && other.path !== skill.path);
    skill.equivalentPaths = peers
      .filter((other) => other.hash === skill.hash)
      .map((other) => other.path);
    skill.ambiguous = peers.some((other) => other.hash !== skill.hash);
  }
  return skills;
}
