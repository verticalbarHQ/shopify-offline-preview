import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { NodeThemeFileSystem } from "../packages/theme/src/node.js";

const manifest = z
  .array(z.object({ name: z.string(), path: z.string(), commit: z.string() }))
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
const browser: typeof import("../packages/check/src/browser.js") = await import(
  new URL("../dist/browser.js", import.meta.url).href
);
const rows = [];
for (const item of manifest) {
  const theme = new NodeThemeFileSystem(item.path);
  const content: Record<string, string> = {};
  for (const file of await theme.listFiles()) {
    if (
      /^(?:layout|templates|sections|blocks|snippets|config|locales)\//.test(file) &&
      /\.(?:json|liquid)$/.test(file)
    )
      content[file] = await theme.readText(file);
  }
  for (const page of benchmarkMatrix) {
    const options = { snapshot: defaultFixture(), scenario: page.scenario, inspect: true };
    const node = await renderTheme(theme, page.path, options);
    const web = await browser.renderTheme(
      new browser.MemoryThemeFileSystem(content),
      page.path,
      options,
    );
    assert.equal(
      JSON.stringify(web),
      JSON.stringify(node),
      `${item.name}/${page.id}: browser/Node mismatch`,
    );
    const repeat = await renderTheme(new MemoryThemeFileSystem(content), page.path, options);
    assert.deepEqual(repeat, node, `${item.name}/${page.id}: repeat mismatch`);
    const counts = Object.fromEntries(
      [...new Set(node.diagnostics.map((d) => d.code))]
        .sort()
        .map((code) => [code, node.diagnostics.filter((d) => d.code === code).length]),
    );
    rows.push({
      theme: item.name,
      commit: item.commit,
      case: page.id,
      htmlBytes: Buffer.byteLength(node.html),
      counts,
      deterministic: true,
      browserParity: true,
    });
    console.log(
      `${item.name}/${page.id}: ${Buffer.byteLength(node.html)} bytes; ${JSON.stringify(counts)}`,
    );
  }
}
await writeFile(
  ".local/results/render-benchmark-summary.json",
  `${JSON.stringify({ status: "initial assembly only; Shopify parity NOT verified", rows }, null, 2)}\n`,
);
console.log(
  `${rows.length} initial renders are deterministic and byte-identical across Node/browser builds. Diagnostics remain; this is NOT a Shopify parity gate.`,
);
