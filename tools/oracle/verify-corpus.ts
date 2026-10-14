import { createHash } from "node:crypto";
import type { Snapshot } from "../../packages/data/src/schema.js";
import { renderTheme } from "../../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../../packages/theme/src/index.js";
import {
  assertPreparedCorpusCase,
  corpusObservationSchema,
  extractCorpusOutput,
  type PreparedCorpusCase,
} from "./corpus.js";
import { type CorpusEnvironment, emptyCorpusEnvironment } from "./corpus-environment.js";
import { snapshotFingerprint } from "./matrix.js";

/** Replays an owned corpus harness. No network, raw output, or implementation promotion. */
export async function verifyCorpusObservation(
  item: PreparedCorpusCase,
  input: unknown,
  context: { snapshot: Snapshot; specCommit: string; environment?: CorpusEnvironment },
) {
  const observation = corpusObservationSchema.parse(input);
  const environment = context.environment ?? emptyCorpusEnvironment;
  const files = assertPreparedCorpusCase(item, environment);
  if (
    observation.specCommit !== context.specCommit ||
    observation.fixtureHash !== snapshotFingerprint(context.snapshot) ||
    observation.harnessHash !== item.harnessHash ||
    observation.caseId !== item.id ||
    observation.name !== item.name ||
    observation.originalInputHash !== item.originalInputHash ||
    observation.preparedInputHash !== item.preparedInputHash ||
    observation.requestPath !== item.requestPath
  )
    throw new Error("Corpus observation does not match the pinned input, fixture and request");
  const result = await renderTheme(new MemoryThemeFileSystem(files), item.requestPath, {
    snapshot: context.snapshot,
  });
  const output = extractCorpusOutput(result.html, item, environment);
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
