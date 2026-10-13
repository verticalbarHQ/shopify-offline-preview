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

test("variant featured media derives from its assigned image and nil image URLs remain empty", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  const variant = product.variants.find((v) => v.image !== null);
  assert.ok(variant);
  const source = `{{product.selected_or_first_available_variant.featured_media.preview_image | image_url: width:32}}|{{nil | image_url: width:32}}`;
  const theme = new MemoryThemeFileSystem({ ...files, "sections/main.liquid": source });
  const result = await renderTheme(theme, `/products/${product.handle}?variant=${variant.id}`, {
    snapshot,
  });
  assert.ok(result.html.includes(`/sop/images/${variant.image}?width=32|`));
  assert.deepEqual(result.diagnostics, []);
  const absent = await renderTheme(theme, `/products/${product.handle}`, {
    snapshot,
    scenario: "no-images",
  });
  assert.ok(absent.html.includes(">|</div>"));
  assert.deepEqual(absent.diagnostics, []);
});

test("inline asset content preserves SVG, JS and CSS bytes without evaluating Liquid", async () => {
  const snapshot = defaultFixture();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><title>Own Icon</title><path d="M0 0h10v10z"/></svg>';
  const css = 'p::after{content:"{{literal}}"}';
  const js = 'window.literal="{{literal}}";';
  const theme = new MemoryThemeFileSystem({
    ...files,
    "assets/own.svg": svg,
    "assets/own.css": css,
    "assets/own.js": js,
    "sections/main.liquid":
      "{{'own.svg'|inline_asset_content}}{{'own.css'|inline_asset_content}}{{'own.js'|inline_asset_content}}",
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  assert.ok(result.html.includes(svg + css + js));
  assert.deepEqual(result.diagnostics, []);
});
test("inline assets enforce type, UTF-8 byte size, missing files and filesystem boundaries", async () => {
  const snapshot = defaultFixture();
  for (const [name, text] of [
    ["large.svg", "x".repeat(15 * 1024)],
    ["unicode.svg", "한".repeat(6000)],
    ["bad.png", "not svg"],
    ["missing.svg", null],
    ["../escape.svg", null],
  ] as const) {
    const theme = new MemoryThemeFileSystem({
      ...files,
      ...(text === null ? {} : { [`assets/${name}`]: text }),
      "sections/main.liquid": `{{'${name}'|inline_asset_content}}After`,
    });
    const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
      snapshot,
    });
    assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
    assert.ok(result.html.includes("After"));
    if (name === "missing.svg")
      assert.ok(result.diagnostics.some((d) => d.code === "missing-resource"));
  }
});

test("inline assets accept the last valid byte size and report invalid UTF-8 consistently", async () => {
  const snapshot = defaultFixture();
  const content = `<svg></svg>${" ".repeat(15 * 1024 - 12)}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "assets/boundary.svg": content,
      "sections/main.liquid": "{{'boundary.svg'|inline_asset_content}}",
    }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  assert.ok(result.html.includes(content));
  assert.deepEqual(result.diagnostics, []);
  const bad = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "assets/bad.svg": new Uint8Array([255]),
      "sections/main.liquid": "{{'bad.svg'|inline_asset_content}}",
    }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  assert.equal(bad.diagnostics[0]?.message, "Inline asset must contain valid UTF-8 text");
});

test("preload tags require an asset kind and preserve escaped HTML attributes", async () => {
  const snapshot = defaultFixture();
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "assets/own.js": "window.own=true;",
      "sections/main.liquid": `{{'own.js'|asset_url|preload_tag:as:'script',type:'text/javascript',title:'A "name" & B',disabled:false}}`,
    }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  assert.ok(
    result.html.includes(
      '<link href="/sop/assets/own.js" as="script" type="text/javascript" title="A &quot;name&quot; &amp; B" rel="preload">',
    ),
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["shopify-server-only"],
  );
  const missing = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "sections/main.liquid": "{{'own.js'|asset_url|preload_tag}}",
    }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  assert.ok(
    missing.diagnostics.some(
      (d) => d.code === "liquid-error" && d.message.includes("as attribute"),
    ),
  );
});
