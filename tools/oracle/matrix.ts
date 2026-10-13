import { createHash } from "node:crypto";
import { z } from "zod";
import { benchmarkMatrix } from "../../packages/data/src/fixture.js";
import type { Snapshot } from "../../packages/data/src/schema.js";
import { assertGoldenFreshness, type GoldenArtifact, goldenArtifactSchema } from "./artifacts.js";
import type { ComparisonNode } from "./summary.js";

export const benchmarkPinSchema = z.strictObject({
  name: z.enum(["dawn", "horizon"]),
  repo: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
export type BenchmarkPin = z.infer<typeof benchmarkPinSchema>;

export function snapshotFingerprint(snapshot: Snapshot): string {
  const canonical = JSON.stringify(snapshot, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
function nodeCounts(nodes: ComparisonNode[]): { sections: number; blocks: number } {
  let sections = 0,
    blocks = 0;
  for (const node of nodes) {
    if (node.kind === "section") sections++;
    else blocks++;
    const children = nodeCounts(node.children);
    sections += children.sections;
    blocks += children.blocks;
  }
  return { sections, blocks };
}

/** Metadata must bind every comparison to its actual fixture, request and pinned theme. */
export function validateGoldenMatrix(
  input: readonly unknown[],
  pins: readonly BenchmarkPin[],
  fixtureHash: string,
  releaseAt?: Date,
): Map<string, GoldenArtifact> {
  const checkedPins = z.array(benchmarkPinSchema).length(2).parse(pins);
  if (new Set(checkedPins.map((pin) => pin.name)).size !== 2)
    throw new Error("Both distinct benchmark pins are required");
  if (!/^[a-f0-9]{64}$/.test(fixtureHash)) throw new Error("Valid actual fixture hash required");
  const output = new Map<string, GoldenArtifact>();
  for (const value of input) {
    const golden = goldenArtifactSchema.parse(value);
    const key = `${golden.theme}/${golden.caseId}`;
    const counts = nodeCounts(golden.summary.tree);
    if (
      !counts.sections ||
      counts.sections !== golden.summary.sections.length ||
      counts.blocks !== golden.summary.markedBlockCount ||
      new Set(golden.summary.sections.map((section) => section.id)).size !== counts.sections
    )
      throw new Error(`Invalid oracle summary structure: ${key}`);
    if (output.has(key)) throw new Error(`Duplicate oracle golden: ${key}`);
    const pin = checkedPins.find((item) => item.name === golden.theme);
    const page = benchmarkMatrix.find((item) => item.id === golden.caseId);
    if (!pin || pin.commit !== golden.themeCommit)
      throw new Error(`Oracle theme pin mismatch: ${key}`);
    if (!page || page.path !== golden.path || page.scenario !== golden.scenario)
      throw new Error(`Oracle request matrix mismatch: ${key}`);
    if (fixtureHash !== golden.fixtureHash) throw new Error(`Oracle fixture mismatch: ${key}`);
    if (releaseAt) assertGoldenFreshness(golden, releaseAt);
    output.set(key, golden);
  }
  const missing = checkedPins.flatMap((pin) =>
    benchmarkMatrix
      .filter((page) => !output.has(`${pin.name}/${page.id}`))
      .map((page) => `${pin.name}/${page.id}`),
  );
  if (missing.length)
    throw new Error(
      `Real Shopify goldens missing for ${missing.length} matrix cases: ${missing.join(", ")}`,
    );
  return output;
}
