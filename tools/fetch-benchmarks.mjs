import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pins = JSON.parse(await readFile("benchmarks.json", "utf8"));
const root = await mkdtemp(join(tmpdir(), "sop-benchmarks-"));
const entries = [];
for (const pin of pins) {
  if (!/^[a-f0-9]{40}$/.test(pin.commit) || !/^Shopify\/(dawn|horizon)$/.test(pin.repo))
    throw new Error("Invalid benchmark pin");
  const path = join(root, pin.name);
  await mkdir(path);
  const archive = join(root, `${pin.name}.tar.gz`);
  execFileSync("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    "120",
    `https://codeload.github.com/${pin.repo}/tar.gz/${pin.commit}`,
    "--output",
    archive,
  ]);
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", path]);
  entries.push({ ...pin, path });
}
await mkdir(".local", { recursive: true });
await writeFile(".local/benchmark-paths.json", `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Benchmarks downloaded outside project: ${root}`);
