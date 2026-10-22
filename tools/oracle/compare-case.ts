import assert from "node:assert/strict";
import type { CompleteSnapshot as Snapshot } from "../../packages/data/src/schema.js";
import { renderTheme } from "../../packages/render/src/index.js";
import type { ThemeFileSystem } from "../../packages/theme/src/index.js";
import { type GoldenArtifact, goldenArtifactSchema } from "./artifacts.js";
import { snapshotFingerprint } from "./matrix.js";
import { sectionTypeMap } from "./section-types.js";
import { compareSummaries, summarizeHtml } from "./summary.js";
/** Uses already calibrated case data verbatim. Reapplying the source scenario would discard observed IDs, keys and Native clock. */
export async function compareGoldenCase(
  theme: ThemeFileSystem,
  input: GoldenArtifact,
  snapshot: Snapshot,
) {
  const golden = goldenArtifactSchema.parse(input);
  assert.equal(
    snapshotFingerprint(snapshot),
    golden.caseSnapshotHash,
    "Calibrated case snapshot fingerprint mismatch",
  );
  assert.equal(snapshot.meta.now, golden.capturedAt, "Calibrated Native capture clock mismatch");
  assert.deepEqual(
    Object.keys(snapshot.scenarios),
    [],
    "Calibrated snapshots must not contain source overlays",
  );
  const result = await renderTheme(theme, golden.path, { snapshot });
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) =>
      ["liquid-error", "not-implemented"].includes(diagnostic.code),
    ),
    [],
    `${golden.theme}/${golden.caseId}: dynamic coverage fails`,
  );
  const actual = summarizeHtml(result.html, {
      sectionTypes: await sectionTypeMap(theme, result.route.template),
    }).summary,
    comparison = compareSummaries(golden.summary, actual);
  assert.ok(
    comparison.equal,
    `${golden.theme}/${golden.caseId}: tree=${comparison.treeEqual}, text=${comparison.textEqual}`,
  );
  return comparison;
}
