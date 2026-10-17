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
test("link_to preserves intended label markup, escapes attributes and applies Shopify's nofollow rule", async () => {
  const snapshot = defaultFixture();
  const source = `{{'Shop'|link_to:'/'}}|{{'<b>A&B</b>'|link_to:'/?q=a&b=2',class:'own'}}|{{'X'|link_to:'/',disabled:true,class:true,hidden:false}}|{{'X'|link_to:'https://www.shopify.com',rel:'author'}}|{{'X'|link_to:'https://shopify.com.evil.test'}}|{{'X'|link_to:'/',title:'A "name" & B',href:'/other'}}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...files, "sections/main.liquid": source }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  for (const expected of [
    '<a href="/" title="">Shop</a>',
    '<a class="own" href="/?q=a&amp;b=2"><b>A&B</b></a>',
    '<a disabled="disabled" class="true" href="/">X</a>',
    '<a rel="nofollow" href="https://www.shopify.com">X</a>',
    '<a href="https://shopify.com.evil.test" title="">X</a>',
    '<a title="A &quot;name&quot; &amp; B" href="/">X</a>',
  ])
    assert.ok(result.html.includes(expected), expected);
  assert.deepEqual(result.diagnostics, []);
});
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

test("variant featured media derives from its assigned image and failed image assignments remain empty", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  const variant = product.variants.find((v) => v.image !== null);
  assert.ok(variant);
  const source = `{% assign preview=product.selected_or_first_available_variant.featured_media.preview_image | image_url:width:32 %}{{preview}}|{% assign absent=nil | image_url:width:32 %}{{absent}}`;
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
  }
});

test("a missing inline asset leaves Shopify's comment, with or without an extension", async () => {
  const snapshot = defaultFixture();
  const theme = new MemoryThemeFileSystem({
    ...files,
    "sections/main.liquid":
      "{{'missing.svg'|inline_asset_content}}|{{'icon-3d-model'|inline_asset_content}}|After",
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  const comment = "<!-- inline_asset_content: Asset not found. -->";
  assert.ok(result.html.includes(`${comment}|${comment}|After`), result.html);
  assert.ok(!result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.equal(result.diagnostics.filter((d) => d.code === "missing-resource").length, 2);
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

test("image URL output reports invalid input while native-style assignments suppress it and preserve old values", async () => {
  const snapshot = defaultFixture();
  const theme = new MemoryThemeFileSystem({
    ...files,
    "sections/main.liquid":
      "{% assign value='Old' %}{% assign value=nil | image_url:width:100 %}Value={{value}}|{{nil|image_url:width:100}}|{{product.featured_media|image_url}}",
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  assert.ok(
    result.html.includes(
      "Value=Old|Liquid error (sections/main.liquid line 1): invalid url input|/sop/images/",
    ),
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});

test("image assignment compatibility does not suppress errors from other filters", async () => {
  const snapshot = defaultFixture();
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "sections/main.liquid": "{% assign price='not a price' | money %}After",
    }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.ok(result.html.includes("After"));
});

test("image_tag removes attributes passed as Liquid nil, as Horizon's product media does", async () => {
  const snapshot = defaultFixture();
  const theme = new MemoryThemeFileSystem({
    ...files,
    "sections/main.liquid": `{{product.featured_image | image_url: width: 64 | image_tag: srcset: nil, sizes: null, width: nil, preload: nil, class: 'own'}}`,
  });
  const result = await renderTheme(theme, `/products/${snapshot.products[0]?.handle}`, {
    snapshot,
  });
  assert.ok(result.html.includes('height="64" class="own">'), result.html);
  for (const absent of ["srcset=", "sizes=", ' width="', "[object Object]", 'rel="preload"'])
    assert.ok(!result.html.includes(absent), `${absent}: ${result.html}`);
  assert.equal(result.diagnostics.length, 0);
});

test("default keeps a kept Liquid object instead of unwrapping it, as Horizon's color fallbacks need", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": '{"layout":false,"sections":{"m":{"type":"m"}},"order":["m"]}',
    "config/settings_schema.json": JSON.stringify([
      {
        name: "Colors",
        settings: [
          { type: "color", id: "page", default: "#102030" },
          { type: "color", id: "unset", default: "" },
        ],
      },
    ]),
    "sections/m.liquid":
      "{% assign c = settings.unset | default: settings.page %}{% assign k = settings.page | default: '#ffffff' %}[{{ c }}|{{ c.rgb }}|{{ k.red }}|{{ template | default: 'x' }}|{{ '' | default: 'fallback' }}]",
  });
  const result = await renderTheme(theme, "/");
  assert.ok(result.html.includes("[#102030|16 32 48|16|index|fallback]"), result.html);
  assert.deepEqual(result.diagnostics, []);
});

test("video_tag renders nothing for an unset video and still rejects other values", async () => {
  const snapshot = defaultFixture();
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "sections/main.liquid": "[{{ nothing | video_tag }}]{{ product | video_tag }}After",
    }),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  assert.ok(result.html.includes("[]"), result.html);
  assert.ok(result.html.includes("After"));
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});
