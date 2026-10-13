import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { formatMoney } from "../packages/render/src/filters/money.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const files = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/product.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
};
test("money formatting retains exact hundredths, shop templates, separators and rounding", () => {
  assert.equal(formatMoney(123456, "USD {{amount}}"), "USD 1,234.56");
  assert.equal(formatMoney(123456, "EUR {{amount_with_comma_separator}}"), "EUR 1.234,56");
  assert.equal(formatMoney(123450, "{{amount_no_decimals}}"), "1,235");
  assert.equal(formatMoney(-12345, `\${{amount}}`), "$-123.45");
  assert.equal(
    formatMoney(123400, `<span>\${{amount}}</span>`, false, true),
    "<span>$1,234</span>",
  );
  assert.equal(formatMoney(123456, `<span>\${{amount}}</span>`, true), "1,234.56");
  assert.throws(() => formatMoney(Number.MAX_SAFE_INTEGER + 1, "{{amount}}"), /safe integer/);
  assert.throws(() => formatMoney(123, "{{made_up}}"), /Unsupported money format/);
});
test("translations select regional files, interpolate, pluralize and escape unless the key is HTML", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.locale = "fr-CA";
  const theme = new MemoryThemeFileSystem({
    ...files,
    "sections/main.liquid": `{{ 'example.greet' | t: name: '<Ada>' }}|{{ 'example.count' | t: count: 2 }}|{{ 'example.raw_html' | t }}|{{ 'example.zero' | t: count: 0 }}`,
    "locales/en.default.json": '{"example":{"greet":"Default"}}',
    "locales/fr.json": '{"example":{"greet":"French"}}',
    "locales/fr-CA.json": JSON.stringify({
      example: {
        greet: "Bonjour {{ name }}",
        count: { one: "{{count}} livre", other: "{{count}} livres" },
        raw_html: "<b>Bold</b>",
        zero: { zero: "No entries", one: "One entry", other: "Entries" },
      },
    }),
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  assert.match(result.html, /Bonjour &lt;Ada&gt;\|2 livres\|<b>Bold<\/b>\|No entries/);
  assert.equal(result.diagnostics.length, 0);
});
test("section locale keys remain scoped and missing translations retain source diagnostics", async () => {
  const snapshot = defaultFixture();
  const theme = new MemoryThemeFileSystem({
    ...files,
    "templates/product.json":
      '{"sections":{"a":{"type":"local"},"b":{"type":"plain"}},"order":["a","b"]}',
    "sections/local.liquid": `{% render 'text' %}{% schema %}{"locales":{"en":{"example":{"word":"Section"}}}}{% endschema %}`,
    "sections/plain.liquid": `{{ 'example.word' | t }}|{{ 'absent' | translate }}`,
    "snippets/text.liquid": `{{ 'example.word' | t }}`,
    "locales/en.default.json": '{"example":{"word":"Theme"}}',
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  assert.ok(result.html.includes(">Section</div>"));
  assert.ok(result.html.includes(">Theme|translation missing: en.absent</div>"));
  assert.equal(result.diagnostics[0]?.file, "sections/plain.liquid");
  assert.equal(result.diagnostics[0]?.code, "missing-resource");
});
test("source asset and image filters preserve local paths, dimensions, alt text and query metadata", async () => {
  const snapshot = defaultFixture();
  const image = snapshot.products[0]?.images[0];
  assert.ok(image);
  const theme = new MemoryThemeFileSystem({
    ...files,
    "assets/demo.css": "h1{color:red}",
    "sections/main.liquid": `{{ 'demo.css' | asset_url | stylesheet_tag }}{{ product.featured_image | image_url: width: 32 | image_tag: class: 'example', widths: '16,32', alt: 'An "image"' }}|{{product.price | money}}`,
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  assert.ok(result.html.includes('href="/sop/assets/demo.css"'));
  assert.ok(result.html.includes('width="32" height="32"'));
  assert.ok(result.html.includes('alt="An &quot;image&quot;"'));
  assert.ok(result.html.includes("width=16 16w"));
  assert.equal(result.diagnostics.length, 0);
  const unsupported = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "sections/main.liquid": `{{product.featured_image | image_url: width: 32, unknown_transform: 'top'}}`,
    }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  assert.equal(unsupported.diagnostics[0]?.code, "not-implemented");
});

test("image URLs retain crop/quality hints and preload metadata while adapters serve original bytes", async () => {
  const snapshot = defaultFixture();
  const theme = new MemoryThemeFileSystem({
    ...files,
    "sections/main.liquid": `{{product.featured_image | image_url: width: 32, height: 16, crop: 'top', quality: 80 | image_tag: preload: true, widths: '16,32'}}`,
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  assert.ok(result.html.includes('width="32" height="16"'));
  assert.ok(result.html.includes('rel="preload"'));
  assert.ok(result.html.includes("imagesrcset="));
  assert.ok(result.html.includes("crop=top"));
  assert.equal(result.diagnostics.length, 0);
});
