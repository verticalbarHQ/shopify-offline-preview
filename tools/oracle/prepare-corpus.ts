import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { prepareCorpus } from "./corpus.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--path-map")
  throw new Error("Usage: prepare-corpus --path-map <fixture-path-map.json>");
const file = args[1];
if (!file) throw new Error("Fixture path mapping file required");
const mapping = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(file, "utf8")));
const source = z
  .array(
    z.object({
      name: z.string(),
      examples: z.array(z.object({ raw_liquid: z.string(), path: z.string() })).optional(),
    }),
  )
  .parse(JSON.parse(await readFile("vendor/theme-liquid-docs/filters.json", "utf8")));
const available = [];
const unavailable = [];
for (const filter of source)
  for (const [index, example] of (filter.examples ?? []).entries()) {
    const item = {
      id: `filters/${filter.name}/${index}`,
      kind: "filters",
      name: filter.name,
      path: example.path,
      liquid: example.raw_liquid,
    };
    if (item.liquid.trim()) available.push(item);
    else
      unavailable.push({ id: item.id, reason: "Upstream example has no executable Liquid input" });
  }
const prepared = prepareCorpus(available, mapping);
const directory = await mkdtemp(join(tmpdir(), "sop-oracle-corpus-"));
for (const [path, contents] of Object.entries(prepared.files)) {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), contents);
}
const manifest = {
  schemaVersion: "1.0",
  spec: JSON.parse(await readFile("upstream.json", "utf8")),
  directory,
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
await writeFile(".local/oracle/corpus-prepared.json", `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    directory,
    preparedCases: prepared.cases.length,
    unavailableExamples: unavailable.length,
    uploaded: false,
    captured: false,
  }),
);
