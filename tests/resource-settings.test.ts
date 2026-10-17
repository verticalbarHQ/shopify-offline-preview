import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(settings: Record<string, unknown>) {
  return new MemoryThemeFileSystem({
    "templates/index.json": JSON.stringify({
      layout: false,
      sections: { main: { type: "main", settings } },
      order: ["main"],
    }),
    "sections/main.liquid":
      '[{{ section.settings.link }}|{{ section.settings.post.title }}|{{ section.settings.post.url }}]{% schema %}{"settings":[{"type":"url","id":"link"},{"type":"article","id":"post"}]}{% endschema %}',
  });
}

test("url settings resolve theme-editor resource URIs and article settings resolve articles", async () => {
  const snapshot = defaultFixture();
  for (const [link, expected] of [
    ["shopify://collections/all", "/collections/all"],
    ["shopify://collections/sop-catalog", "/collections/sop-catalog"],
    ["shopify://products/sop-matrix-needle", "/products/sop-matrix-needle"],
    ["shopify://pages/about", "/pages/about"],
    ["shopify://blogs/news", "/blogs/news"],
    ["shopify://blogs/news/story-1", "/blogs/news/story-1"],
    ["/collections/all?sort_by=price-ascending", "/collections/all?sort_by=price-ascending"],
    ["https://example.org/x", "https://example.org/x"],
  ]) {
    const result = await renderTheme(theme({ link, post: "news/story-2" }), "/", { snapshot });
    assert.ok(
      result.html.includes(`[${expected}|Example Story 2|/blogs/news/story-2]`),
      `${link}: ${result.html}`,
    );
    assert.deepEqual(result.diagnostics, []);
  }
});

test("absent resources in url and article settings resolve to nil with missing-resource", async () => {
  const result = await renderTheme(
    theme({ link: "shopify://products/missing", post: "news/missing" }),
    "/",
    { snapshot: defaultFixture() },
  );
  assert.ok(result.html.includes("[||]"), result.html);
  assert.deepEqual(
    result.diagnostics.map((d) => `${d.code}: ${d.message}`),
    [
      "missing-resource: Setting link references a resource absent from the snapshot.",
      "missing-resource: Setting post references a resource absent from the snapshot.",
    ],
  );
  const unsupported = await renderTheme(theme({ link: "shopify://metaobjects/a/b" }), "/", {
    snapshot: defaultFixture(),
  });
  assert.deepEqual(
    unsupported.diagnostics.map((d) => `${d.code}: ${d.message}`),
    ["not-implemented: Setting link uses an unsupported resource URL shopify://metaobjects/a/b."],
  );
});
