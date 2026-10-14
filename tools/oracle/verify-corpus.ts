import { createHash } from "node:crypto";
import type { Snapshot } from "../../packages/data/src/schema.js";
import { renderTheme } from "../../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../../packages/theme/src/index.js";
import {
  corpusObservationSchema,
  extractCorpusOutput,
  type PreparedCorpusCase,
  prepareCorpus,
} from "./corpus.js";
import { snapshotFingerprint } from "./matrix.js";

/** Replays an owned corpus harness. No network, raw output, or implementation promotion. */
export async function verifyCorpusObservation(
  item: PreparedCorpusCase,
  input: unknown,
  context: { snapshot: Snapshot; specCommit: string },
) {
  const observation = corpusObservationSchema.parse(input);
  // Reconstruct from original source rather than trusting manifest-derived paths/files.
  const prepared = prepareCorpus(
    [{ id: item.id, kind: item.kind, name: item.name, path: item.path, liquid: item.liquid }],
    { [item.path]: item.fixturePath },
  );
  const expected = prepared.cases[0];
  if (
    !expected ||
    Object.entries(expected).some(([key, value]) => Reflect.get(item, key) !== value)
  )
    throw new Error("Prepared corpus provenance or routing has changed");
  if (
    observation.specCommit !== context.specCommit ||
    observation.fixtureHash !== snapshotFingerprint(context.snapshot) ||
    observation.caseId !== item.id ||
    observation.name !== item.name ||
    observation.originalInputHash !== item.originalInputHash ||
    observation.preparedInputHash !== item.preparedInputHash ||
    observation.requestPath !== item.requestPath
  )
    throw new Error("Corpus observation does not match the pinned input, fixture and request");
  const result = await renderTheme(new MemoryThemeFileSystem(prepared.files), item.requestPath, {
    snapshot: context.snapshot,
  });
  const output = extractCorpusOutput(result.html, item);
  const outputHash = createHash("sha256").update(output).digest("hex");
  const outputBytes = Buffer.byteLength(output);
  // Equal hashes alone cannot turn an error, unsupported filter, server omission or
  // missing resource into a successful conformance case.
  const blockers = result.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === "error" ||
      ["not-implemented", "missing-resource", "shopify-server-only"].includes(diagnostic.code),
  );
  const outputEqual =
    outputHash === observation.outputHash && outputBytes === observation.outputBytes;
  return {
    caseId: item.id,
    outputEqual,
    outputHash,
    outputBytes,
    diagnosticCodes: [...new Set(blockers.map((diagnostic) => diagnostic.code))].sort(),
    pass: outputEqual && blockers.length === 0,
  };
}
