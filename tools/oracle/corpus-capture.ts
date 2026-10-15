import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectVerifiedOracleCorpusCase, type VerifiedOracleCorpusCase } from "./case-capture.js";
import {
  corpusObservationSchema,
  extractCorpusOutput,
  savePrivateCorpusCapture,
} from "./corpus.js";
import { inspectPreparedFilterCorpus, type PreparedFilterCorpus } from "./corpus-source.js";
import { verifyCorpusObservation } from "./verify-corpus.js";

/** Derives every observation field from the pinned source and calibrated capture; accepts no caller hashes or clock. */
export function inspectCorpusCapture(
  source: PreparedFilterCorpus,
  receipt: VerifiedOracleCorpusCase,
) {
  const info = inspectPreparedFilterCorpus(source),
    record = inspectVerifiedOracleCorpusCase(receipt),
    item = record.request.item;
  if (info.manifestHash !== record.request.manifestHash)
    throw new Error("Corpus source differs from the verified capture");
  const outputs = record.capture.privateRawHtml.map((html) =>
    extractCorpusOutput(html, item, info.environment),
  );
  if (outputs.length !== 2 || outputs[0] === undefined || outputs[0] !== outputs[1])
    throw new Error("Unstable corpus output; no observation is retained");
  const output = outputs[0];
  const observation = corpusObservationSchema.parse({
    schemaVersion: "1.0",
    source: "shopify-storefront",
    specCommit: record.request.specCommit,
    fixtureHash: record.snapshotHash,
    harnessHash: item.harnessHash,
    caseId: item.id,
    name: item.name,
    originalInputHash: item.originalInputHash,
    preparedInputHash: item.preparedInputHash,
    requestPath: record.path,
    capturedAt: record.capture.capturedAt,
    doubleCaptureStable: true,
    outputHash: createHash("sha256").update(output).digest("hex"),
    outputBytes: Buffer.byteLength(output),
  });
  return {
    observation,
    privateRawHtml: record.capture.privateRawHtml,
    privateOutputs: outputs,
    snapshot: record.snapshot,
    binding: {
      baseCaseId: record.caseId,
      baseFixtureHash: record.baseFixtureHash,
      stateHash: record.stateHash,
      contextHash: record.contextHash,
      manifestHash: info.manifestHash,
      filesHash: info.filesHash,
    },
  };
}
/** Data replay only. A passing comparison does not promote a feature or create a benchmark golden. */
export async function replayCorpusCapture(
  source: PreparedFilterCorpus,
  receipt: VerifiedOracleCorpusCase,
) {
  const info = inspectPreparedFilterCorpus(source),
    record = inspectVerifiedOracleCorpusCase(receipt),
    capture = inspectCorpusCapture(source, receipt);
  return verifyCorpusObservation(record.request.item, capture.observation, {
    snapshot: capture.snapshot,
    specCommit: info.spec.commit,
    environment: info.environment,
  });
}
/** Saves the exact calibrated snapshot next to the raw outputs in the existing ignored private capture directory. */
export async function saveVerifiedCorpusCapture(
  source: PreparedFilterCorpus,
  receipt: VerifiedOracleCorpusCase,
) {
  const result = inspectCorpusCapture(source, receipt),
    directory = await savePrivateCorpusCapture(result);
  for (const [name, value] of [
    ["snapshot.json", result.snapshot],
    ["binding.json", result.binding],
  ] as const)
    await writeFile(join(directory, name), `${JSON.stringify(value)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  return directory;
}
