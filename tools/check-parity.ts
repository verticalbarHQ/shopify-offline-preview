import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import { parseSnapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";
import { instrumentTheme } from "./oracle/instrument-theme.js";
import { benchmarkPinSchema, snapshotFingerprint, validateGoldenMatrix } from "./oracle/matrix.js";
import { sectionTypeMap } from "./oracle/section-types.js";
import { compareSummaries, summarizeHtml } from "./oracle/summary.js";

const args = process.argv.slice(2);
let snapshotFile: string | undefined;
let release = false;
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === "--release" && !release) release = true;
  else if (option === "--snapshot" && snapshotFile === undefined) {
    snapshotFile = args[++index];
    if (!snapshotFile || snapshotFile.startsWith("--")) throw new Error("Snapshot file required");
  } else throw new Error("Usage: check-parity [--snapshot <snapshot.json>] [--release]");
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
const manifest = z
  .array(z.object({ name: z.string(), path: z.string(), commit: z.string() }))
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
for (const pin of pins) {
  const item = manifest.find((entry) => entry.name === pin.name && entry.commit === pin.commit);
  assert.ok(item, `Pinned benchmark download missing: ${pin.name}`);
  const copy = await instrumentTheme(item.path);
  try {
    const fs = new NodeThemeFileSystem(copy.path);
    for (const page of benchmarkMatrix) {
      const result = await renderTheme(fs, page.path, { snapshot, scenario: page.scenario });
      assert.deepEqual(
        result.diagnostics.filter((diagnostic) =>
          ["liquid-error", "not-implemented"].includes(diagnostic.code),
        ),
        [],
        `${pin.name}/${page.id}: dynamic coverage fails`,
      );
      const actual = summarizeHtml(result.html, {
        sectionTypes: await sectionTypeMap(fs, result.route.template),
      }).summary;
      const expected = goldens.get(`${pin.name}/${page.id}`);
      assert.ok(expected);
      const comparison = compareSummaries(expected.summary, actual);
      assert.ok(
        comparison.equal,
        `${pin.name}/${page.id}: tree=${comparison.treeEqual}, text=${comparison.textEqual}`,
      );
      console.log(`${pin.name}/${page.id}: Shopify tree/text parity PASS`);
    }
  } finally {
    await rm(copy.path, { recursive: true, force: true });
  }
}
console.log(
  "36 actual Shopify golden comparisons passed. Static oracle coverage is a separate required gate.",
);
