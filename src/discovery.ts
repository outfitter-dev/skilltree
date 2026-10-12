import * as fs from "node:fs";
import { join, relative, resolve, dirname, posix } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { fail, relativePath, SkilltreeError, type Tree } from "./model";
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
export interface Hold {
  path: string;
  scope: "skill" | "projection";
  code: string;
  message: string;
}
export interface Discovery {
  skills: Skill[];
  holds: Hold[];
}
export function metadata(root: string): { name: string; description: string } {
  return metadataTree(readTree(root));
}
export function metadataTree(tree: Tree): { name: string; description: string } {
  if (!tree["SKILL.md"]) fail("INVALID_SKILL", "Skill root must contain SKILL.md");
  const text = Buffer.from(tree["SKILL.md"].data, "base64").toString("utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) fail("INVALID_SKILL", "SKILL.md requires YAML name and description frontmatter");
  let frontmatter: Record<string, unknown>;
  try {
    const doc = parseDocument(match[1]!, { uniqueKeys: true });
    if (doc.errors.length) fail("INVALID_SKILL", "Invalid or duplicate YAML frontmatter keys");
    frontmatter = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>;
  } catch {
    return fail("INVALID_SKILL", "Invalid or duplicate YAML frontmatter keys");
  }
  const meta = z
    .object({ name: z.string().min(1).max(200), description: z.string().min(1).max(4000) })
    .safeParse(frontmatter);
  if (!meta.success)
    fail("INVALID_SKILL", "SKILL.md requires valid name and description frontmatter");
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
        return fail("INVALID_REFERENCE", `Malformed local reference: ${path}`);
      }
      const target = posix.normalize(posix.join(dirname(path), link));
      if (!link || !tree[target] || link.startsWith("/") || target.startsWith("../"))
        fail(
          "MISSING_REFERENCE",
          `Local reference is outside the complete skill file set: ${path}`,
        );
    }
  }
  return meta.data;
}
export function discover(root: string): Discovery {
  // The acquired root is a source-wide safety boundary. Only known projection
  // validation failures below it are isolated; I/O and unexpected failures abort.
  assertNoSymlinks(root);
  const holds: Hold[] = [];
  const found = new Map<string, Skill>();
  function checked(path: string, scope: Hold["scope"], work: () => void) {
    try {
      work();
    } catch (error) {
      if (!(error instanceof SkilltreeError)) throw error;
      holds.push({ path, scope, code: error.code, message: error.message });
    }
  }
  for (const path of [
    ".cursor-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".chatgpt-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
  ]) {
    if (exists(join(root, path)))
      holds.push({
        path,
        scope: "projection",
        code: "UNSUPPORTED_FORMAT",
        message: `${path} requires an adapter whose manifest semantics have been verified`,
      });
  }
  function scan(dir: string, format: string) {
    const path = relative(root, dir);
    checked(path, "projection", () => {
      if (!inside(root, dir)) fail("UNSAFE_PATH", "Plugin skill path escapes source");
      assertNoSymlinks(dir);
      if (!exists(dir)) return;
      if (!fs.statSync(dir).isDirectory())
        fail("UNSAFE_TREE", "Skill projection is not a directory");
      if (exists(join(dir, "SKILL.md"))) {
        checked(path, "skill", () => {
          if (!relativePath.safeParse(path).success) fail("UNSAFE_PATH", "Unsupported skill path");
          if (!found.has(path)) {
            const tree = readTree(dir);
            found.set(path, {
              path,
              ...metadataTree(tree),
              format,
              hash: treeHash(tree),
              equivalentPaths: [],
              ambiguous: false,
            });
          }
        });
        return;
      }
      for (const entry of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) {
          holds.push({
            path: relative(root, join(dir, entry.name)),
            scope: "projection",
            code: "UNSAFE_TREE",
            message: "Symlink in skill discovery tree",
          });
        } else if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name))
          scan(join(dir, entry.name), format);
      }
    });
  }
  for (const path of [".agents/skills", ".claude/skills", "skills"])
    scan(join(root, path), "plain");
  const pluginPath = ".claude-plugin/plugin.json";
  const plugin = join(root, pluginPath);
  if (exists(plugin)) {
    checked(pluginPath, "projection", () => {
      assertNoSymlinks(plugin);
      let config: { skills?: string[] | undefined };
      try {
        config = z
          .object({ skills: z.array(z.string()).optional() })
          .parse(JSON.parse(fs.readFileSync(plugin, "utf8")));
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
        return fail("INVALID_PLUGIN", "Invalid Claude plugin skill declarations");
      }
      for (const path of config.skills ?? ["./skills"]) {
        checked(pluginPath, "projection", () => {
          if (!path.startsWith("./") || !relativePath.safeParse(path.slice(2)).success)
            fail(
              "INVALID_PLUGIN",
              "Claude skill paths must be safe source-relative paths starting with ./",
            );
          const target = resolve(root, path.slice(2));
          if (!inside(root, target)) fail("UNSAFE_PATH", "Plugin skill path escapes source");
          scan(target, "claude-plugin");
        });
      }
    });
  }
  const skills = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const skill of skills) {
    const peers = skills.filter((other) => other.name === skill.name && other.path !== skill.path);
    skill.equivalentPaths = peers
      .filter((other) => other.hash === skill.hash)
      .map((other) => other.path);
    skill.ambiguous = peers.some((other) => other.hash !== skill.hash);
  }
  return { skills, holds: holds.sort((a, b) => a.path.localeCompare(b.path)) };
}
export function selectedHold(discovery: Discovery, path: string): Hold | undefined {
  const direct = discovery.holds.find(
    (hold) => path === hold.path || path.startsWith(hold.path + "/"),
  );
  if (direct) return direct;
  if (
    discovery.skills.some((skill) => skill.path === path) ||
    [".agents/skills/", ".claude/skills/", "skills/"].some((prefix) => path.startsWith(prefix))
  )
    return undefined;
  return discovery.holds.find((hold) => hold.path === ".claude-plugin/plugin.json");
}
