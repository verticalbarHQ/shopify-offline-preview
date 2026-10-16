import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source = "{{page_title}}|{{page_description}}") {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    ...Object.fromEntries(
      ["index", "product", "collection", "page", "search", "cart", "404", "blog", "article"].map(
        (type) => [
          `templates/${type}.json`,
          '{"sections":{"main":{"type":"main"}},"order":["main"]}',
        ],
      ),
    ),
    "sections/main.liquid": source,
  });
}
test("resource titles, resolved descriptions and SEO overrides map to their exact source reads", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0];
  assert.ok(product);
  product.seo = { title: "Own <SEO>", description: "Own & description" };
  const result = await renderTheme(theme(), `/products/${product.handle}`, {
    snapshot,
    inspect: true,
  });
  assert.ok(result.html.includes("Own &lt;SEO&gt;|Own & description"));
  assert.deepEqual(result.diagnostics, []);
  const section = result.tree[0]?.children[0];
  assert.ok(section);
  assert.deepEqual(result.dataUsed[section.id], [
    "products[0].seo.description",
    "products[0].seo.title",
  ]);
  product.seo = { title: null, description: null };
  const fallback = await renderTheme(theme(), `/products/${product.handle}`, { snapshot });
  assert.ok(fallback.html.includes(`${product.title}|`));
  assert.deepEqual(fallback.diagnostics, []);
});

test("English system page titles include query result counts and descriptions come from the appropriate source", async () => {
  for (const [path, title, description] of [
    ["/", "Offline Example Shop", "A synthetic catalog for local theme development."],
    ["/cart", "Your Shopping Cart", ""],
    ["/collections/all", "Products", ""],
    ["/search", "Search", "A synthetic catalog for local theme development."],
    [
      "/search?q=Matrix%20Needle",
      "Search: 1 result found for &quot;Matrix Needle&quot;",
      "A synthetic catalog for local theme development.",
    ],
    [
      "/search?q=zzzxnevermatch983147",
      "Search: 0 results found for &quot;zzzxnevermatch983147&quot;",
      "A synthetic catalog for local theme development.",
    ],
    ["/unknown", "404 Not Found", ""],
  ]) {
    const result = await renderTheme(theme(), path ?? "/");
    assert.ok(result.html.includes(`${title}|${description}`), path);
    assert.deepEqual(result.diagnostics, [], path);
  }
  for (const path of [
    "/collections/sop-catalog",
    "/pages/about",
    "/blogs/news",
    "/blogs/news/story-1",
  ])
    assert.deepEqual((await renderTheme(theme(), path)).diagnostics, [], path);
});

test("missing resolved metadata stays diagnosed, non-English system labels disclose the fallback and SEO stays outside shop Liquid properties", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0];
  assert.ok(product);
  delete product.seo;
  const missing = await renderTheme(theme(), `/products/${product.handle}`, { snapshot });
  assert.equal(missing.diagnostics.filter((d) => d.code === "missing-resource").length, 2);
  assert.ok(missing.html.includes(product.title));
  snapshot.shop.locale = "fr";
  const localized = await renderTheme(theme(), "/cart", { snapshot });
  assert.ok(
    localized.diagnostics.some(
      (d) => d.code === "not-implemented" && d.message.includes("Localized"),
    ),
  );
  const shop = await renderTheme(theme("{{shop.seo}}"), "/");
  assert.ok(
    shop.diagnostics.some((d) => d.code === "not-implemented" && d.message.includes("shop.seo")),
  );
});
