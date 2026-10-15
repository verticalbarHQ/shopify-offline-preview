import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseSnapshot, type Snapshot } from "../../packages/data/src/schema.js";
import { type GoldenArtifact, goldenArtifactSchema, makeGoldenArtifact } from "./artifacts.js";
import { inspectVerifiedOracleCase, type VerifiedOracleCase } from "./case-capture.js";
import { snapshotFingerprint } from "./matrix.js";

export class CaseArchiveError extends Error {
  constructor(
    readonly code: "invalid-archive" | "snapshot-mismatch" | "unsafe-path" | "duplicate-case",
  ) {
    super(`Oracle case archive failed: ${code}`);
    this.name = "CaseArchiveError";
  }
}
const entrySchema = goldenArtifactSchema
    .omit({ schemaVersion: true, summary: true, doubleCaptureStable: true })
    .extend({ snapshotFile: z.string().regex(/^[a-f0-9]{64}\.json$/) }),
  manifestSchema = z.strictObject({
    schemaVersion: z.literal("1.0"),
    fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(entrySchema).min(1).max(36),
  });
async function privateFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size > 8 * 1024 * 1024
    )
      throw new CaseArchiveError("unsafe-path");
    const text = await handle.readFile("utf8"),
      after = await handle.stat(),
      current = await lstat(path);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink()
    )
      throw new CaseArchiveError("unsafe-path");
    return text;
  } finally {
    await handle.close();
  }
}
async function writePrivate(path: string, text: string) {
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new CaseArchiveError("invalid-archive");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Immutable, owner-only snapshots. Public summaries carry hashes; full shop/resource input stays under ignored .local. */
export async function savePrivateCaseArchive(
  receipts: readonly VerifiedOracleCase[],
): Promise<{ directory: string; manifest: string }> {
  if (!receipts.length || receipts.length > 36) throw new CaseArchiveError("invalid-archive");
  const records = receipts.map((receipt) => ({
      record: inspectVerifiedOracleCase(receipt),
      golden: makeGoldenArtifact(receipt),
    })),
    base = records[0]?.record.baseFixtureHash,
    keys = new Set<string>();
  if (!base || records.some(({ record }) => record.baseFixtureHash !== base))
    throw new CaseArchiveError("invalid-archive");
  for (const { golden } of records) {
    const key = `${golden.theme}/${golden.caseId}`;
    if (keys.has(key)) throw new CaseArchiveError("duplicate-case");
    keys.add(key);
  }
  const root = resolve(".local"),
    caseRoot = join(root, "oracle/cases");
  for (const path of [root, join(root, "oracle"), caseRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (
      (await realpath(path)) !== path ||
      !(await lstat(path)).isDirectory() ||
      (await lstat(path)).isSymbolicLink()
    )
      throw new CaseArchiveError("unsafe-path");
  }
  if (((await lstat(caseRoot)).mode & 0o077) !== 0) throw new CaseArchiveError("unsafe-path");
  const directory = await mkdtemp(join(caseRoot, "capture-")),
    written = new Set<string>(),
    entries = [];
  for (const { record, golden } of records) {
    const snapshotFile = `${golden.caseSnapshotHash}.json`;
    if (!written.has(snapshotFile)) {
      await writePrivate(join(directory, snapshotFile), `${JSON.stringify(record.snapshot)}\n`);
      written.add(snapshotFile);
    }
    const {
      schemaVersion: _version,
      summary: _summary,
      doubleCaptureStable: _stable,
      ...metadata
    } = golden;
    entries.push({ ...metadata, snapshotFile });
  }
  const manifest = join(directory, "manifest.json");
  await writePrivate(
    manifest,
    `${JSON.stringify(manifestSchema.parse({ schemaVersion: "1.0", fixtureHash: base, entries }), null, 2)}\n`,
  );
  return { directory, manifest };
}
/** Strictly binds restored local data to every public golden's exact calibrated fingerprint and capture time. No source-fixture fallback. */
export async function readCaseSnapshots(
  manifestPath: string,
  goldens: ReadonlyMap<string, GoldenArtifact>,
  fixtureHash: string,
): Promise<Map<string, Snapshot>> {
  try {
    const path = resolve(manifestPath),
      root = dirname(path),
      stat = await lstat(root);
    if (
      (await realpath(root)) !== root ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    )
      throw new CaseArchiveError("unsafe-path");
    const manifest = manifestSchema.parse(JSON.parse(await privateFile(path))),
      output = new Map<string, Snapshot>();
    if (manifest.fixtureHash !== fixtureHash || manifest.entries.length !== goldens.size)
      throw new CaseArchiveError("invalid-archive");
    const inventory = new Set([
        basename(path),
        ...manifest.entries.map((entry) => entry.snapshotFile),
      ]),
      actualFiles = await readdir(root);
    if (actualFiles.length !== inventory.size || actualFiles.some((file) => !inventory.has(file)))
      throw new CaseArchiveError("invalid-archive");
    for (const entry of manifest.entries) {
      const key = `${entry.theme}/${entry.caseId}`,
        golden = goldens.get(key);
      if (!golden || output.has(key)) throw new CaseArchiveError("duplicate-case");
      const { snapshotFile, ...metadata } = entry,
        {
          schemaVersion: _version,
          summary: _summary,
          doubleCaptureStable: _stable,
          ...expected
        } = golden;
      if (
        !isDeepStrictEqual(metadata, expected) ||
        entry.snapshotFile !== `${entry.caseSnapshotHash}.json`
      )
        throw new CaseArchiveError("snapshot-mismatch");
      const snapshot = parseSnapshot(await privateFile(join(root, snapshotFile)));
      if (
        snapshotFingerprint(snapshot) !== entry.caseSnapshotHash ||
        snapshot.meta.now !== entry.capturedAt ||
        Object.keys(snapshot.scenarios).length
      )
        throw new CaseArchiveError("snapshot-mismatch");
      output.set(key, snapshot);
    }
    return output;
  } catch (error) {
    if (error instanceof CaseArchiveError) throw error;
    throw new CaseArchiveError("invalid-archive");
  }
}
