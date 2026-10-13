import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { benchmarkMatrix, defaultFixture } from "../../packages/data/src/fixture.js";
import { renderTheme } from "../../packages/render/src/index.js";
import { NodeThemeFileSystem } from "../../packages/theme/src/node.js";
import { instrumentTheme } from "./instrument-theme.js";
import { sectionTypeMap } from "./section-types.js";
import { assertStableCapture, summarizeHtml } from "./summary.js";

const manifest = z
  .array(z.object({ name: z.string(), path: z.string() }))
  .parse(JSON.parse(await readFile(".local/benchmark-paths.json", "utf8")));
const rows = [];
for (const item of manifest) {
  const copy = await instrumentTheme(item.path);
  try {
    const fs = new NodeThemeFileSystem(copy.path);
    const maps = new Map<string, Record<string, string>>();
    for (const page of benchmarkMatrix) {
      const options = { snapshot: defaultFixture(), scenario: page.scenario };
      const result = await renderTheme(fs, page.path, options);
      assert.deepEqual(
        result.diagnostics.filter((d) => d.code === "liquid-error"),
        [],
        `${item.name}/${page.id}: instrumentation introduces Liquid errors`,
      );
      let sectionTypes = maps.get(result.route.template);
      if (!sectionTypes) {
        sectionTypes = await sectionTypeMap(fs, result.route.template);
        maps.set(result.route.template, sectionTypes);
      }
      const summary = summarizeHtml(result.html, { sectionTypes });
      const repeat = await renderTheme(fs, page.path, options);
      assertStableCapture(summary.summary, summarizeHtml(repeat.html, { sectionTypes }).summary);
      rows.push({
        theme: item.name,
        case: page.id,
        sections: summary.summary.sections.length,
        markedBlocks: summary.summary.markedBlockCount,
        stable: true,
      });
      console.log(
        `${item.name}/${page.id}: ${summary.summary.sections.length} sections; ${summary.summary.markedBlockCount} marked blocks; comparison pipeline stable`,
      );
    }
  } finally {
    await rm(copy.path, { recursive: true, force: true });
  }
}
await writeFile(
  ".local/results/offline-comparison-pipeline.json",
  `${JSON.stringify({ status: "pass", scope: "Offline pipeline only; these are not Shopify goldens", rows }, null, 2)}\n`,
);
