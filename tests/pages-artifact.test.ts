import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Pages allows first-party adapter names but rejects benchmark bytes and embedded sources", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sop-pages-policy-"));
  try {
    const artifact = join(temp, "artifact"),
      benchmark = join(temp, "benchmark");
    await cp("dist/playground", artifact, { recursive: true });
    await mkdir(benchmark);
    const content = "<h1>Distinct authored stand-in for a licensed benchmark file</h1>";
    await writeFile(join(benchmark, "product.liquid"), content);
    const metadata = join(temp, "benchmarks.json");
    await writeFile(metadata, JSON.stringify([{ name: "dawn", path: benchmark }]));
    const check = () =>
      spawnSync(process.execPath, ["tools/check-pages-artifact.mjs", artifact, metadata], {
        encoding: "utf8",
      });
    await writeFile(
      join(artifact, "compatibility.js"),
      "export const dawn = {}; // Horizon is also a theme name\n",
    );
    const allowed = check();
    assert.equal(allowed.status, 0, allowed.stderr);
    const copied = join(artifact, "copied.txt");
    await writeFile(copied, content);
    const direct = check();
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /Benchmark file dawn\/product.liquid/);
    await rm(copied);
    await writeFile(
      join(artifact, "compatibility.js.map"),
      JSON.stringify({ sourcesContent: [content] }),
    );
    const embedded = check();
    assert.notEqual(embedded.status, 0);
    assert.match(embedded.stderr, /Benchmark source dawn\/product.liquid/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
