import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { corpusEnvironmentSchema, emptyCorpusEnvironment } from "./corpus-environment.js";
import {
  inspectPreparedFilterCorpus,
  preparePinnedFilterCorpus,
  readPreparedFilterCorpusFiles,
} from "./corpus-source.js";

const args = process.argv.slice(2);
let file: string | undefined;
let environmentFile: string | undefined;
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  const value = args[++index];
  if (!value || value.startsWith("--")) throw new Error("Corpus option value required");
  if (flag === "--path-map" && !file) file = value;
  else if (flag === "--environment" && !environmentFile) environmentFile = value;
  else throw new Error("Usage: prepare-corpus --path-map <file> [--environment <file>]");
}
if (!file) throw new Error("Fixture path mapping file required");
let environment = emptyCorpusEnvironment;
if (environmentFile) {
  try {
    environment = corpusEnvironmentSchema.parse(
      JSON.parse(await readFile(environmentFile, "utf8")),
    );
  } catch {
    throw new Error("Corpus environment document is invalid");
  }
}
const mapping = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(file, "utf8")));
const receipt = await preparePinnedFilterCorpus(mapping, environment),
  prepared = inspectPreparedFilterCorpus(receipt),
  unavailable = prepared.unavailable,
  files = readPreparedFilterCorpusFiles(receipt);
const directory = await mkdtemp(join(tmpdir(), "sop-oracle-corpus-"));
for (const [path, contents] of Object.entries(files)) {
  await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, path), contents, { mode: 0o600 });
}
const manifest = {
  schemaVersion: "1.0",
  spec: prepared.spec,
  sourceHash: prepared.sourceHash,
  filesHash: prepared.filesHash,
  manifestHash: prepared.manifestHash,
  directory,
  environment,
  cases: prepared.cases,
  unavailable,
  status: "Prepared only; no Shopify capture or implementation evidence",
};
const privateRoot = resolve(".local");
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
if ((await realpath(privateRoot)) !== privateRoot)
  throw new Error("Private corpus manifest root cannot be a symlink");
await mkdir(".local/oracle", { recursive: true, mode: 0o700 });
if ((await realpath(".local/oracle")) !== resolve(".local/oracle"))
  throw new Error("Private corpus manifest path cannot contain symlinks");
const staging = await mkdtemp(join(resolve(".local/oracle"), "manifest-"));
try {
  const temporary = join(staging, "prepared.json");
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, resolve(".local/oracle/corpus-prepared.json"));
} finally {
  await rm(staging, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    directory,
    preparedCases: prepared.cases.length,
    unavailableExamples: unavailable.length,
    uploaded: false,
    captured: false,
  }),
);
