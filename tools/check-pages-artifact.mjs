// Guards the GitHub Pages artifact: only the playground build, the synthetic fixture images and
// the original sample theme may ship. Benchmark (Shopify-licensed) theme files must never appear.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.argv[2] ?? "dist/playground";
const sampleSource = "fixtures/sample-theme";
const sampleDir = "sample-theme/";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function list(path) {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(path, join(entry.parentPath, entry.name)))
    .sort();
}
const files = await list(root);
for (const file of files) console.log(file);

const themeShaped = /(^|\/)(layout|templates|sections|snippets|blocks|locales|config)\/|\.liquid$/;
for (const file of files.filter((f) => !f.startsWith(sampleDir)))
  assert.ok(!themeShaped.test(file), `Theme file outside ${sampleDir}: ${file}`);

// The sample directory must be byte-identical to the committed original sample theme.
const expected = await list(sampleSource);
const shipped = files.filter((f) => f.startsWith(sampleDir)).map((f) => f.slice(sampleDir.length));
assert.deepEqual(shipped, [...expected, "manifest.json"].sort(), "Sample theme file set changed");
for (const file of expected)
  assert.equal(
    hash(await readFile(join(root, sampleDir, file))),
    hash(await readFile(join(sampleSource, file))),
    `Sample theme file differs from source: ${file}`,
  );
assert.deepEqual(
  JSON.parse(await readFile(join(root, sampleDir, "manifest.json"), "utf8")),
  expected,
  "Sample theme manifest does not match its files",
);

for (const file of files) {
  const text = await readFile(join(root, file), "latin1");
  assert.ok(!/dawn|horizon/i.test(text), `Benchmark theme name found in ${file}`);
}

// When benchmarks are fetched (CI does), compare every shipped file against their hashes.
let compared = 0;
if (existsSync(".local/benchmark-paths.json")) {
  const forbidden = new Map();
  for (const theme of JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")))
    for (const file of await list(theme.path))
      forbidden.set(hash(await readFile(join(theme.path, file))), `${theme.name}/${file}`);
  for (const file of files) {
    const match = forbidden.get(hash(await readFile(join(root, file))));
    assert.ok(!match, `Benchmark file ${match} shipped as ${file}`);
  }
  compared = forbidden.size;
}
console.log(
  `Pages artifact PASS: ${files.length} files, ${expected.length} sample theme files, ` +
    `${compared} benchmark hashes compared.`,
);
