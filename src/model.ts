import { z } from "zod";

export class SkilltreeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(code: string, message: string): never {
  throw new SkilltreeError(code, message);
}
export const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      p
        .split("/")
        .every((s) => s !== ".." && s !== "." && s !== "" && s !== ".git" && s !== "__proto__"),
    "unsafe relative path",
  );
export const fileSchema = z
  .object({
    data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    executable: z.boolean(),
  })
  .strict();
export const treeSchema = z
  .record(relativePath, fileSchema)
  .refine(
    (tree) =>
      !!tree["SKILL.md"] &&
      Object.keys(tree).every(
        (path) =>
          !path
            .split("/")
            .some((segment) =>
              [".git", "node_modules", "workflow.md", "runs.json"].includes(segment),
            ),
      ),
    "missing SKILL.md or reserved file",
  );
export type Tree = z.infer<typeof treeSchema>;
const version = z.object({ hash, revision: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict();
const approval = z
  .object({
    hash,
    reason: z.string().min(1),
    kind: z.enum(["user-install", "explicit-review"]),
    at: z.string(),
  })
  .strict();
export const entrySchema = z
  .object({
    id: slug,
    source: slug,
    path: relativePath,
    name: z.string().min(1),
    profiles: z.array(slug),
    upstream: version,
    local: z
      .object({
        hash,
        base: hash,
        commit: z.string().regex(/^[a-f0-9]{40,64}$/),
        archive: hash.optional(),
        checkout: z.string().uuid().optional(),
      })
      .strict()
      .nullable(),
    candidate: version.nullable(),
    approval: approval.nullable(),
    deployed: version.nullable(),
    observed: hash.nullable(),
    deployedBase: hash.nullable(),
    outcome: z.enum(["STAGED", "HELD", "CONFLICT", "DRIFT", "CURRENT", "UPDATED"]),
    reasons: z.array(z.string()),
  })
  .strict();
export type Entry = z.infer<typeof entrySchema>;
export const sourceSchema = z
  .object({
    id: slug,
    repository: z.string().min(1),
    ref: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{40,64}$/),
    checkout: z.string().uuid().optional(),
    archive: hash.optional(),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
export const lockSchema = z
  .object({ version: z.literal(1), sources: z.array(sourceSchema), entries: z.array(entrySchema) })
  .strict();
export type Lock = z.infer<typeof lockSchema>;
export const manifestSchema = z
  .object({
    version: z.literal(1),
    destination: z.string().min(1),
    adapter: z.enum(["filesystem", "grok"]),
    transactionStorage: z.string().min(1).optional(),
    runtimeRoot: z.string().min(1).optional(),
    runtimeVersion: z.literal(2).optional(),
    libraryRecoveryVersion: z.literal(1).optional(),
    legacyRuntime: z.string().optional(),
    legacyLockName: z.enum(["kernel.lock", "sync.lock"]).optional(),
    lockBackend: z.enum(["mkdir", "flock"]).optional(),
    hostMetadata: z.array(z.enum(["workflow.md", "runs.json"])).optional(),
    exclusiveDestination: z.literal(true),
    gardener: slug,
    primary: slug.nullable(),
    policy: z.literal("manual"),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
const journalFields = {
  transaction: z.string().uuid(),
  id: slug,
  oldHash: hash.nullable(),
  next: entrySchema,
};
export const journalSchema = z.discriminatedUnion("version", [
  z.object({ version: z.literal(1), ...journalFields }).strict(),
  z.object({ version: z.literal(2), storage: z.string().min(1), ...journalFields }).strict(),
  z.object({ version: z.literal(3), storage: z.string().min(1), ...journalFields }).strict(),
]);
export type Journal = z.infer<typeof journalSchema>;
