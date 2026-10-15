import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { registry } from "../../packages/spec/src/index.js";
import { type PreparedCorpusCase, prepareCorpus } from "./corpus.js";
import {
  type CorpusEnvironment,
  type CorpusFiles,
  corpusEnvironmentSchema,
  corpusFilesFingerprint,
  emptyCorpusEnvironment,
} from "./corpus-environment.js";

export class CorpusSourceError extends Error {
  constructor(readonly code: "invalid-input" | "source-mismatch" | "unverified-source") {
    super(`Oracle corpus source failed: ${code}`);
    this.name = "CorpusSourceError";
  }
}
export interface PreparedFilterCorpus {
  readonly kind: "prepared-filter-corpus";
}
interface CorpusRecord {
  spec: { repository: string; commit: string; files: string[] };
  sourceHash: string;
  filesHash: string;
  manifestHash: string;
  cases: PreparedCorpusCase[];
  unavailable: { id: string; reason: string }[];
  environment: CorpusEnvironment;
  files: CorpusFiles;
}
const records = new WeakMap<PreparedFilterCorpus, CorpusRecord>(),
  digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Reads only the pinned vendored filter inputs. Mapping/dependencies stay explicit; no request, rendering or promotion. */
export async function preparePinnedFilterCorpus(
  inputMapping: Readonly<Record<string, string>>,
  inputEnvironment: CorpusEnvironment = emptyCorpusEnvironment,
): Promise<PreparedFilterCorpus> {
  let mapping: Record<string, string>, environment: CorpusEnvironment;
  try {
    mapping = z.record(z.string(), z.string()).parse(inputMapping);
    environment = corpusEnvironmentSchema.parse(inputEnvironment);
  } catch {
    throw new CorpusSourceError("invalid-input");
  }
  const [pinBytes, bytes] = await Promise.all([
    readFile(new URL("../../upstream.json", import.meta.url)),
    readFile(new URL("../../vendor/theme-liquid-docs/filters.json", import.meta.url)),
  ]);
  const spec = z
      .object({
        repository: z.string(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        files: z.array(z.string()),
      })
      .parse(JSON.parse(pinBytes.toString("utf8"))),
    sourceHash = digest(bytes);
  if (
    spec.repository !== registry.repository ||
    spec.commit !== registry.commit ||
    sourceHash !== registry.hashes["filters.json"] ||
    !spec.files.includes("filters.json")
  )
    throw new CorpusSourceError("source-mismatch");
  const source = z
      .array(
        z.object({
          name: z.string(),
          examples: z.array(z.object({ raw_liquid: z.string(), path: z.string() })).optional(),
        }),
      )
      .parse(JSON.parse(bytes.toString("utf8"))),
    inputs = [],
    unavailable: CorpusRecord["unavailable"] = [];
  for (const filter of source)
    for (const [index, example] of (filter.examples ?? []).entries()) {
      const item = {
        id: `filters/${filter.name}/${index}`,
        kind: "filters" as const,
        name: filter.name,
        path: example.path,
        liquid: example.raw_liquid,
      };
      if (item.liquid.trim()) inputs.push(item);
      else
        unavailable.push({
          id: item.id,
          reason: "Upstream example has no executable Liquid input",
        });
    }
  let prepared: ReturnType<typeof prepareCorpus>;
  try {
    prepared = prepareCorpus(inputs, mapping, environment);
  } catch {
    throw new CorpusSourceError("invalid-input");
  }
  const entries = Object.values(prepared.files),
    sizes = entries.map((body) => Buffer.byteLength(body));
  // Match the full-inventory reader's limits before any upload could be dispatched.
  if (
    !prepared.cases.length ||
    entries.length > 1000 ||
    sizes.some((size) => size > 32 * 1024 * 1024) ||
    sizes.reduce((a, b) => a + b, 0) > 128 * 1024 * 1024
  )
    throw new CorpusSourceError("invalid-input");
  const filesHash = corpusFilesFingerprint(prepared.files),
    manifestHash = digest(JSON.stringify({ spec, sourceHash, filesHash, cases: prepared.cases })),
    receipt: PreparedFilterCorpus = Object.freeze({ kind: "prepared-filter-corpus" });
  records.set(receipt, {
    spec,
    sourceHash,
    filesHash,
    manifestHash,
    ...prepared,
    unavailable,
    environment,
  });
  return receipt;
}
export function inspectPreparedFilterCorpus(receipt: PreparedFilterCorpus) {
  const record = records.get(receipt);
  if (!record) throw new CorpusSourceError("unverified-source");
  const { files: _files, ...metadata } = record;
  return structuredClone(metadata);
}
export function readPreparedFilterCorpusFiles(receipt: PreparedFilterCorpus): CorpusFiles {
  const record = records.get(receipt);
  if (!record) throw new CorpusSourceError("unverified-source");
  return structuredClone(record.files);
}
