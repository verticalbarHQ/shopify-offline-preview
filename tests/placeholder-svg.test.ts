import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { snapshotSchema } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

// Authored test art; no Shopify platform artwork or benchmark theme source is bundled.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M1 1L19 19"/></svg>';
function files(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  };
}
async function render(source: string, data = svg) {
  const snapshot = defaultFixture();
  snapshot.placeholderSvgs = { "collection-1": data };
  return renderTheme(new MemoryThemeFileSystem(files(source)), "/", { snapshot, inspect: true });
}
test("placeholder SVG preserves supplied artwork bytes and inserts only a root class", async () => {
  const result = await render(
    "{{'collection-1'|placeholder_svg_tag}}|{{'collection-1'|placeholder_svg_tag:'own-class'}}",
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(
    result.html.includes(`${svg}|${svg.replace("<svg", '<svg class="own-class"')}`),
    result.html,
  );
  assert.ok(Object.values(result.dataUsed).flat().includes("placeholderSvgs.collection-1"));
});
test("nil, false, empty and whitespace classes leave the original source intact", async () => {
  const result = await render(
    "{{'collection-1'|placeholder_svg_tag:nil}}|{{'collection-1'|placeholder_svg_tag:false}}|{{'collection-1'|placeholder_svg_tag:''}}|{{'collection-1'|placeholder_svg_tag:'  '}}",
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes([svg, svg, svg, svg].join("|")));
});
test("class conversion preserves numbers, array inspection and Shopify's literal insertion", async () => {
  const result = await render(
    `{{'collection-1'|placeholder_svg_tag:0}}|{{'collection-1'|placeholder_svg_tag:3.0}}|{{'collection-1'|placeholder_svg_tag:true}}|{%assign classes='a,b'|split:','%}{{'collection-1'|placeholder_svg_tag:classes}}|{{'collection-1'|placeholder_svg_tag:'x&<>"y'}}`,
  );
  assert.deepEqual(result.diagnostics, []);
  for (const text of [
    'class="0"',
    'class="3.0"',
    'class="true"',
    'class="["a", "b"]"',
    'class="x&<>"y"',
  ])
    assert.ok(result.html.includes(text), result.html);
});
test("missing local art is a missing resource and never pretends to be oracle verified", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(files("{{'hero-apparel-1'|placeholder_svg_tag:'hero'}}|After")),
    "/",
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "missing-resource").length, 1);
  assert.ok(
    !result.diagnostics.some((d) => d.code === "not-implemented" || d.code === "liquid-error"),
  );
  assert.ok(result.html.includes(">|After</div>"), result.html);
});
test("missing and unknown names match the documented runtime errors", async () => {
  const result = await render(
    "{{nil|placeholder_svg_tag}}|{{false|placeholder_svg_tag}}|{{''|placeholder_svg_tag}}|{{'own-unknown'|placeholder_svg_tag}}|After",
  );
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "liquid-error").map((d) => d.message),
    [
      "Missing SVG placeholder",
      "Unknown SVG placeholder 'false'",
      "Unknown SVG placeholder ''",
      "Unknown SVG placeholder 'own-unknown'",
    ],
  );
  assert.ok(result.html.includes("|After"));
});
test("malformed, multiple, class-bearing and non-SVG catalog entries fail explicitly", async () => {
  for (const data of [
    "<div>wrong</div>",
    "<svg>",
    "<svg/><svg/>",
    '<svg class="wrong"/>',
    '<svg xmlns="urn:wrong"/>',
  ]) {
    const result = await render("{{'collection-1'|placeholder_svg_tag}}|After", data);
    assert.ok(
      result.diagnostics.some((d) => d.code === "liquid-error"),
      data,
    );
    assert.ok(result.html.includes("|After"), data);
  }
});
test("catalog schema accepts partial known names and rejects unknown names or oversized data", () => {
  const snapshot = defaultFixture();
  snapshot.placeholderSvgs = { "collection-1": svg };
  assert.ok(snapshotSchema.safeParse(snapshot).success);
  assert.ok(!snapshotSchema.safeParse({ ...snapshot, placeholderSvgs: { unknown: svg } }).success);
  assert.ok(
    !snapshotSchema.safeParse({
      ...snapshot,
      placeholderSvgs: { "collection-1": "x".repeat(2_000_001) },
    }).success,
  );
});
test("self-closing source SVGs retain their syntax when a class is inserted", async () => {
  const result = await render(
    "{{'collection-1'|placeholder_svg_tag:'own'}}",
    '<svg viewBox="0 0 10 10"/>',
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes('<svg class="own" viewBox="0 0 10 10"/>'));
});
test("placeholder data and diagnostics match between Node and browser without mutation", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const snapshot = defaultFixture();
  snapshot.placeholderSvgs = { "collection-1": svg };
  const original = structuredClone(snapshot);
  const input = files(
    "{{'collection-1'|placeholder_svg_tag:'own'}}|{{'image'|placeholder_svg_tag}}",
  );
  const options = { snapshot, inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
  assert.deepEqual(snapshot, original);
});
test("non-TTY CLI consumes the catalog through the normal local data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sop-placeholder-cli-"));
  try {
    const theme = join(root, "theme"),
      data = join(root, "data");
    for (const [file, text] of Object.entries(
      files("{{'collection-1'|placeholder_svg_tag:'own'}}"),
    )) {
      const path = join(theme, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    await mkdir(join(data, "images"), { recursive: true });
    const snapshot = defaultFixture();
    snapshot.placeholderSvgs = { "collection-1": svg };
    await writeFile(join(data, "snapshot.json"), JSON.stringify(snapshot));
    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", "render", theme, "/", "--data", data, "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.diagnostics, []);
    assert.ok(output.html.includes(svg.replace("<svg", '<svg class="own"')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
