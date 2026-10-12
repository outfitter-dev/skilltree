import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fixture, install, authoritative } from "./helpers";
import { load } from "../src/state";
import { execute } from "../src/service";
import { createLibrarySnapshot, readLibrarySnapshot } from "../src/library-backup";
import { compactLibrary } from "../src/library-maintenance";
import { type BlobBoundary } from "../src/scratch-journal";
const heldPhases = new Set<BlobBoundary>([
  "journal-opened",
  "intent-partial",
  "reservation-partial",
  "creation-partial",
]);
for (const phase of [
  "journal-opened",
  "reservation-partial",
  "reservation-written",
  "reservation-durable",
  "intent-opened",
  "intent-partial",
  "intent-durable",
  "temp-created",
  "creation-partial",
  "creation-written",
  "created-durable",
  "payload-written",
  "blob-published",
] as BlobBoundary[]) {
  test(`actual interruption at ${phase} preserves recovery points and reports scratch accurately`, () => {
    const f = fixture();
    try {
      install(f.home);
      const point = createLibrarySnapshot(load(f.home), "completed point");
      if (phase === "journal-opened")
        fs.renameSync(join(f.home, "library-scratch.jsonl"), join(f.home, "preserved-journal"));
      const payload = "new boundary payload " + phase,
        key = createHash("sha256").update(payload).digest("hex");
      const killed = spawnSync(
        process.execPath,
        [
          "-e",
          `import {putBlob} from "./src/library-backup.ts";const data=Buffer.from(process.env.TEST_SCRATCH_PAYLOAD!);putBlob(process.env.TEST_SCRATCH_HOME!,process.env.TEST_SCRATCH_HASH!,data,undefined,(phase)=>{if(phase===process.env.TEST_SCRATCH_PHASE)process.kill(process.pid,"SIGKILL");});`,
        ],
        {
          env: {
            ...process.env,
            TEST_SCRATCH_HOME: f.home,
            TEST_SCRATCH_PAYLOAD: payload,
            TEST_SCRATCH_HASH: key,
            TEST_SCRATCH_PHASE: phase,
          },
        },
      );
      expect(killed.signal).toBe("SIGKILL");
      const before = authoritative(f.home),
        preview = compactLibrary(load(f.home), { backupScratch: true, dryRun: true });
      expect(authoritative(f.home)).toBe(before);
      const doctor = execute(f.home, "doctor", []) as {
        outcome: string;
        backupScratch: { held: unknown[] };
      };
      expect(doctor.backupScratch.held.length > 0).toBe(heldPhases.has(phase));
      if (heldPhases.has(phase)) expect(doctor.outcome).toBe("ERROR");
      expect(authoritative(f.home)).toBe(before);
      const result = compactLibrary(load(f.home), { backupScratch: true });
      expect(result.held.length > 0).toBe(heldPhases.has(phase));
      expect(
        fs.readdirSync(join(f.home, "library-blobs")).filter((n) => n.endsWith(".tmp")),
      ).toHaveLength(0);
      const artifacts = fs.readdirSync(join(f.home, "library-temp-records"));
      expect(artifacts.length).toBe(phase === "intent-partial" ? 1 : 0);
      if (heldPhases.has(phase) && phase !== "creation-partial")
        expect(authoritative(f.home)).toBe(before);
      expect(readLibrarySnapshot(load(f.home), point.id)).toEqual(point);
      expect(preview.held.length > 0).toBe(heldPhases.has(phase));
    } finally {
      f.cleanup();
    }
  });
}
test("doctor exposes unowned empty blobs and markers without mutating or deleting them", () => {
  const f = fixture();
  try {
    install(f.home);
    createLibrarySnapshot(load(f.home), "complete");
    const key = createHash("sha256").update("unowned").digest("hex"),
      temp = join(f.home, "library-blobs", `${key}.bin.11111111-1111-4111-8111-111111111111.tmp`),
      marker = join(f.home, "library-temp-records", temp.split("/").at(-1)! + ".json");
    fs.writeFileSync(temp, "", { mode: 0o600 });
    fs.writeFileSync(marker, "", { mode: 0o600 });
    const before = authoritative(f.home),
      doctor = execute(f.home, "doctor", []) as {
        outcome: string;
        backupScratch: { held: { root: string; reason: string }[] };
      };
    expect(doctor.outcome).toBe("ERROR");
    expect(doctor.backupScratch.held.some((h) => h.root === temp)).toBe(true);
    expect(authoritative(f.home)).toBe(before);
    expect(compactLibrary(load(f.home), { backupScratch: true }).held).toHaveLength(1);
    expect(authoritative(f.home)).toBe(before);
  } finally {
    f.cleanup();
  }
});
