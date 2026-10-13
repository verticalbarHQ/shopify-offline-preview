import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const themes = JSON.parse(await readFile(".local/benchmark-paths.json", "utf8"));
const pins = JSON.parse(await readFile("benchmarks.json", "utf8"));
assert.deepEqual(
  themes.map(({ path: _path, ...pin }) => pin),
  pins,
  "Download manifest does not match pins",
);
const root = resolve(".");
for (const theme of themes)
  assert.ok(!resolve(theme.path).startsWith(`${root}/`), "Benchmark must be outside project");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(path, exclude = new Set()) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (exclude.has(entry.name) || entry.name.startsWith("HANDOFF-")) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) output.push(...(await files(file, exclude)));
    else if (entry.isFile()) output.push(file);
  }
  return output;
}
const forbidden = new Map();
for (const theme of themes)
  for (const file of await files(theme.path)) forbidden.set(hash(await readFile(file)), file);
for (const file of await files(root, new Set(["node_modules", ".git", ".local", "dist"]))) {
  assert.ok(
    !forbidden.has(hash(await readFile(file))),
    `Benchmark file present in project: ${file}`,
  );
}
const readme = await readFile("README.md", "utf8");
assert.equal(readme.split("\n")[0], "Unofficial — not affiliated with or endorsed by Shopify");
console.log(
  `License guard PASS: compared project sources against ${forbidden.size} benchmark file hashes.`,
);
