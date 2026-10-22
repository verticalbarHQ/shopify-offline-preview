import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import { parseCompleteSnapshot as parseSnapshot } from "../packages/data/src/schema.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";
import { readComparisonThemeFiles } from "./oracle/benchmark-theme.js";
import { readCaseSnapshots } from "./oracle/case-archive.js";
import { compareGoldenCase } from "./oracle/compare-case.js";
import { corpusFilesFingerprint } from "./oracle/corpus-environment.js";
import { instrumentTheme } from "./oracle/instrument-theme.js";
import { benchmarkPinSchema, snapshotFingerprint, validateGoldenMatrix } from "./oracle/matrix.js";

const args = process.argv.slice(2);
let snapshotFile: string | undefined;
let caseManifest: string | undefined;
let release = false;
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === "--release" && !release) release = true;
  else if (option === "--snapshot" && snapshotFile === undefined) {
    snapshotFile = args[++index];
    if (!snapshotFile || snapshotFile.startsWith("--")) throw new Error("Snapshot file required");
  } else if (option === "--case-snapshots" && caseManifest === undefined) {
    caseManifest = args[++index];
    if (!caseManifest || caseManifest.startsWith("--"))
      throw new Error("Case snapshot manifest required");
  } else
    throw new Error(
      "Usage: check-parity [--snapshot <snapshot.json>] --case-snapshots <manifest.json> [--release]",
    );
}
const snapshot = snapshotFile
  ? parseSnapshot(await readFile(snapshotFile, "utf8"))
  : defaultFixture();
const fixtureHash = snapshotFingerprint(snapshot);
const pins = z
  .array(benchmarkPinSchema)
  .parse(JSON.parse(await readFile("benchmarks.json", "utf8")));
const artifacts: unknown[] = [];
for (const pin of pins) {
  const directory = join("oracle/goldens", pin.name);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") files = [];
    else throw error;
  }
  for (const file of files.filter((name) => name.endsWith(".json")).sort())
    artifacts.push(JSON.parse(await readFile(join(directory, file), "utf8")));
}
// Missing real captures fail before rendering. Offline observations are never promoted to goldens.
const goldens = validateGoldenMatrix(
  artifacts,
  pins,
  fixtureHash,
  release ? new Date() : undefined,
);
if (!caseManifest)
  throw new Error("Exact calibrated case snapshots required: --case-snapshots <manifest.json>");
const caseSnapshots = await readCaseSnapshots(caseManifest, goldens, fixtureHash);
const manifest = z
  .array(z.object({ name: z.string(), path: z.string(), commit: z.string() }))
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
for (const pin of pins) {
  const item = manifest.find((entry) => entry.name === pin.name && entry.commit === pin.commit);
  assert.ok(item, `Pinned benchmark download missing: ${pin.name}`);
  const copy = await instrumentTheme(item.path, { captureContext: true });
  try {
    const fs = new NodeThemeFileSystem(copy.path);
    const filesHash = corpusFilesFingerprint(await readComparisonThemeFiles(copy.path));
    for (const page of benchmarkMatrix) {
      const key = `${pin.name}/${page.id}`,
        expected = goldens.get(key),
        snapshot = caseSnapshots.get(key);
      assert.ok(expected && snapshot);
      assert.equal(
        filesHash,
        expected.themeFilesHash,
        `${key}: local pinned comparison-copy file mismatch`,
      );
      await compareGoldenCase(fs, expected, snapshot);
      console.log(`${key}: Shopify tree/text parity PASS`);
    }
  } finally {
    await rm(copy.path, { recursive: true, force: true });
  }
}
console.log(
  "36 actual Shopify golden comparisons passed. Static oracle coverage is a separate required gate.",
);
