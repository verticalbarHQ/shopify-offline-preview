import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/product.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "templates/article.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `<script type="application/ld+json">${source}</script>`,
  });
}
function data(html: string) {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match);
  return JSON.parse(match[1] ?? "");
}

test("structured products distinguish default variants, groups and source taxonomy without fetching", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.category = { name: "Arts &amp; Crafts" };
  product.descriptionHtml = "<p>Paint &amp; paper</p>\n<p>More &lt;/script&gt; ideas.</p>";
  const result = await renderTheme(
    theme("{{product|structured_data}}"),
    `/products/${product.handle}`,
    { snapshot, inspect: true },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(!result.html.includes("</script> ideas"));
  const output = data(result.html);
  assert.equal(output["@type"], "ProductGroup");
  assert.equal(output.category, "Arts & Crafts");
  assert.equal(output.description, "Paint & paper\nMore </script> ideas.");
  assert.equal(output.productGroupID, product.id);
  assert.equal(output.hasVariant.length, 8);
  assert.equal(output.hasVariant[0].name, "SOP Matrix Needle - Red / Small / Cotton");
  assert.equal(output.hasVariant[0].offers.price, "12.50");
  assert.equal(output.hasVariant[7].offers.availability, "http://schema.org/OutOfStock");
  assert.equal(output.hasVariant[0].offers.priceCurrency, "USD");
  assert.equal(output.hasVariant[0].image, "/sop/images/pattern-01.png?width=1920");
  const simple = snapshot.products[1];
  assert.ok(simple);
  simple.images = [];
  for (const variant of simple.variants) variant.image = null;
  const single = data(
    (
      await renderTheme(theme("{{product|structured_data}}"), `/products/${simple.handle}`, {
        snapshot,
      })
    ).html,
  );
  assert.equal(single["@type"], "Product");
  assert.ok(!("hasVariant" in single));
  assert.ok(!("productGroupID" in single));
  assert.ok(!("image" in single));
  assert.equal(single.offers.price, "11.00");
  assert.equal(single.name, simple.title);
  assert.equal(single.category, simple.productType);
  assert.ok(
    Object.values(result.dataUsed)
      .flat()
      .some((path) => path.includes("category")),
  );
});

test("structured variants retain parent product identity through public resource objects", async () => {
  const result = await renderTheme(
    theme("{{product.variants.first|structured_data}}"),
    "/products/sop-matrix-needle",
  );
  assert.deepEqual(result.diagnostics, []);
  const value = data(result.html);
  assert.equal(value["@type"], "Product");
  assert.equal(value.name, "SOP Matrix Needle - Red / Small / Cotton");
  assert.ok(!("@context" in value));
  assert.equal(value.image, "/sop/images/pattern-01.png?width=1920");
  assert.ok(
    value.offers.url.startsWith("https://example.test/products/sop-matrix-needle?variant="),
  );
});

test("structured articles use creation and publication times, plain source text and optional image", async () => {
  const snapshot = defaultFixture();
  const article = snapshot.blogs[0]?.articles[0];
  assert.ok(article);
  article.createdAt = "2026-10-01T00:00:00Z";
  article.publishedAt = "2026-10-02T00:00:00Z";
  article.updatedAt = "2026-10-03T00:00:00Z";
  article.image = null;
  article.excerptHtml = "<strong>A &amp; B</strong>";
  const result = await renderTheme(theme("{{article|structured_data}}"), "/blogs/news/story-1", {
    snapshot,
  });
  assert.deepEqual(result.diagnostics, []);
  const value = data(result.html);
  assert.equal(value["@type"], "Article");
  assert.equal(value.datePublished, article.createdAt);
  assert.equal(value.dateModified, article.publishedAt);
  assert.equal(value.description, "A & B");
  assert.equal(value.articleBody, "Original example article 1.");
  assert.deepEqual(value.author, { "@type": "Person", name: "Example Author" });
  assert.deepEqual(value.publisher, { "@type": "Organization", name: snapshot.shop.name });
  assert.ok(!("image" in value));
});

test("missing structured metadata remains diagnosed and unrelated input is blank", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  delete product.category;
  delete product.id;
  const result = await renderTheme(
    theme("{{product|structured_data}}"),
    `/products/${product.handle}`,
    { snapshot },
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "missing-resource").length, 2);
  assert.ok(!("productGroupID" in data(result.html)));
  const invalid = await renderTheme(
    theme('{{nil|structured_data}}{{"text"|structured_data}}{{product.title|structured_data}}'),
    `/products/${product.handle}`,
    { snapshot },
  );
  assert.ok(invalid.html.includes('<script type="application/ld+json"></script>'));
  assert.deepEqual(invalid.diagnostics, []);
});

test("product JSON projects storefront fields without circular collections or inventory disclosure", async () => {
  const result = await renderTheme(theme("{{product|json}}"), "/products/sop-matrix-needle");
  assert.deepEqual(result.diagnostics, []);
  const product = data(result.html);
  assert.equal(product.id, 100001);
  assert.equal(product.images[0], "/sop/images/pattern-01.png");
  assert.equal(product.featured_image, product.images[0]);
  assert.ok(!("collections" in product));
  assert.ok(!("selected_variant" in product));
  assert.ok(!("inventory_quantity" in product.variants[0]));
  assert.ok(!("inventory_policy" in product.variants[0]));
  assert.equal(product.variants[0].requires_shipping, true);
  assert.equal(product.variants[0].taxable, true);
  assert.equal(product.variants[0].name, "SOP Matrix Needle - Red / Small / Cotton");
  const nested = await renderTheme(
    theme("{{product.collections|json}}"),
    "/products/sop-matrix-needle",
  );
  assert.deepEqual(nested.diagnostics, []);
  assert.ok(Array.isArray(data(nested.html)));
  const plain = await renderTheme(theme('{{"</script>&"|json}}'), "/products/sop-matrix-needle");
  assert.equal(data(plain.html), "</script>&");
  assert.ok(plain.html.includes("\\u003c\\/script\\u003e\\u0026"));
});
