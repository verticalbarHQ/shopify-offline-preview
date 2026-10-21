import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { validateSnapshotReferences } from "../packages/data/src/scenarios.js";
import { parseSnapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function partial() {
  const source = defaultFixture();
  for (const key of ["name", "locale", "money_format", "money_with_currency_format"])
    Reflect.deleteProperty(source.shop, key);
  Reflect.deleteProperty(source, "filters");
  for (const product of source.products) {
    for (const variant of product.variants) {
      Reflect.deleteProperty(variant, "available");
      Reflect.deleteProperty(variant, "image");
      Reflect.set(variant, "sku", null);
      Reflect.set(variant, "barcode", null);
    }
    for (const image of product.images) {
      Reflect.deleteProperty(image, "width");
      Reflect.deleteProperty(image, "height");
    }
  }
  for (const collection of source.collections) {
    Reflect.deleteProperty(collection, "image");
    Reflect.deleteProperty(collection, "products");
  }
  for (const blog of source.blogs)
    for (const article of blog.articles) {
      Reflect.deleteProperty(article, "publishedAt");
      Reflect.deleteProperty(article, "image");
    }
  for (const menu of source.menus)
    for (const link of menu.links) Reflect.deleteProperty(link, "resourceHandle");
  return parseSnapshot(JSON.stringify(source));
}

async function render(text: string, snapshot = partial(), path = "/") {
  return renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{ content_for_layout }}",
      "templates/product.json": JSON.stringify({
        sections: { main: { type: "partial" } },
        order: ["main"],
      }),
      "templates/article.json": JSON.stringify({
        sections: { main: { type: "partial" } },
        order: ["main"],
      }),
      "templates/collection.json": JSON.stringify({
        sections: { main: { type: "partial" } },
        order: ["main"],
      }),
      "templates/search.json": JSON.stringify({
        sections: { main: { type: "partial" } },
        order: ["main"],
      }),
      "templates/index.json": JSON.stringify({
        sections: { main: { type: "partial" } },
        order: ["main"],
      }),
      "sections/partial.liquid": text,
    }),
    path,
    { snapshot },
  );
}

test("partial snapshot preserves unknown fields and known nulls without inventing defaults", () => {
  const snapshot = partial();
  validateSnapshotReferences(snapshot);
  assert.equal(Object.hasOwn(snapshot.shop, "name"), false);
  assert.equal(Object.hasOwn(snapshot, "filters"), false);
  assert.equal(snapshot.products[0]?.variants[0]?.sku, null);
});

test("partial data renders and reports accessed missing fields with source context", async () => {
  const result = await render(`{% assign p = collections.all.products.first %}
{{shop.name}}|{{shop.locale}}|{{1234 | money}}|{{1234 | money_with_currency}}
{{p.available}}|{{p.first_available_variant}}|{{p.variants.first.available}}|{{p.variants.first.image}}
{{p.images.first.width}}|{{p.images.first.height}}|{{p.images.first.aspect_ratio}}
{% for c in collections %}{{c.products}}|{{c.products_count}}|{{c.image}}|{{c.filters}}{% endfor %}`);
  assert.ok(
    !result.diagnostics.some((d) => d.code === "liquid-error"),
    JSON.stringify(result.diagnostics),
  );
  const missing = result.diagnostics.filter((d) => d.code === "missing-resource");
  for (const name of [
    "shop.name",
    "shop.locale",
    "money_format",
    "money_with_currency_format",
    "available",
    "width",
    "height",
    "products",
    "image",
    "filters",
  ])
    assert.ok(
      missing.some((d) => d.message.includes(name)),
      name,
    );
  assert.ok(missing.some((d) => d.file === "sections/partial.liquid" && d.line !== null));
  assert.doesNotMatch(result.html, /NaN|undefined|false|USD/);
});

test("known false, null and empty data retain their distinct behavior", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  for (const variant of product.variants) {
    variant.available = false;
    variant.image = null;
  }
  snapshot.filters = [];
  const result = await render(
    `{% assign p = collections.all.products.first %}{{p.available}}|{{p.variants.first.available}}|{{p.variants.first.image}}|{{collections.all.filters.size}}`,
    snapshot,
  );
  assert.ok(result.html.includes("false|false||0"));
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "missing-resource"),
    [],
  );
});

test("derived availability, image associations and option state stay unknown", async () => {
  const result = await render(`{% assign p = collections.all.products.first %}
{{p.selected_or_first_available_variant == nil}}
{{p.options_with_values.first.selected_value}}
{{p.options_with_values.first.values.first.selected}}
{{p.options_with_values.first.values.first.available}}
{{p.images.first.attached_to_variant?}}{{p.images.first.variants}}
{{p.collections}}`);
  assert.doesNotMatch(result.html, /false|Default Title/);
  const messages = result.diagnostics
    .filter((d) => d.code === "missing-resource")
    .map((d) => d.message);
  for (const key of [
    "selected_or_first_available_variant",
    "selected_value",
    "selected",
    "available",
    "attached_to_variant?",
    "variants",
    "collections",
  ])
    assert.ok(
      messages.some((message) => message.includes(key)),
      key,
    );
});

test("article dates, images, menu resources and external video previews may be omitted", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  assert.ok(product);
  product.media = [
    ...product.images.map((image) => ({ mediaType: "image" as const, file: image.file })),
    {
      mediaType: "external_video",
      alt: "Recorded video",
      host: "youtube",
      externalId: "recorded-id",
    },
  ];
  const result = await render(
    `{% assign p = collections.all.products.first %}
{{p.media.last.preview_image}}{{p.media.last.aspect_ratio}}
{% for b in blogs %}{% for a in b.articles %}{{a.published_at}}{{a.image}}{% endfor %}{% endfor %}
{{blogs.news.articles.first.published_at}}{{blogs.news.articles.first.image}}
{% for link in linklists.main-menu.links %}{{link.object}}{% endfor %}`,
    snapshot,
  );
  assert.ok(
    !result.diagnostics.some((d) => d.code === "liquid-error"),
    JSON.stringify(result.diagnostics),
  );
  for (const key of ["preview_image", "aspect_ratio", "published_at", "image", "resourceHandle"])
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes(key)),
      key,
    );
});

test("missing localization and format inputs do not produce inferred text", async () => {
  const result = await render(
    `{{page_title}}|{{request.locale.iso_code}}|{{request.locale.direction}}|{{'greeting' | t}}|{{'2026-01-01' | date: format: 'long'}}|{{1234 | money_without_currency}}`,
  );
  assert.ok(
    !result.diagnostics.some((d) => d.code === "liquid-error"),
    JSON.stringify(result.diagnostics),
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("locale")),
  );
  assert.doesNotMatch(result.html, /January|USD|ltr|undefined/);
});

test("only explicitly optional fields are relaxed; supplied invalid values still fail", () => {
  const snapshot = partial();
  Reflect.set(snapshot.shop, "locale", null);
  assert.throws(() => parseSnapshot(JSON.stringify(snapshot)));
  Reflect.deleteProperty(snapshot.shop, "locale");
  Reflect.set(snapshot.products[0]?.images[0] ?? {}, "width", 0);
  assert.throws(() => parseSnapshot(JSON.stringify(snapshot)));
});

test("image filters diagnose missing dimensions without NaN attributes", async () => {
  const result = await render(
    `{% assign p = collections.all.products.first %}{{p.images.first | image_url: width: 300 | image_tag}}`,
  );
  assert.match(result.html, /<img /);
  assert.doesNotMatch(result.html, /NaN|undefined|height="0"/);
  for (const key of ["width", "height"])
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes(key)),
    );
});

test("unknown filtering and availability never produce an asserted empty result count", async () => {
  const snapshot = partial();
  const collection = snapshot.collections[0];
  assert.ok(collection);
  collection.products = snapshot.products.map((product) => product.handle);
  const result = await render(
    "{{collection.products_count}}|{{collection.products}}|{{collection.filters}}",
    snapshot,
    `/collections/${collection.handle}?filter.v.availability=1`,
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("filters")),
  );
  assert.doesNotMatch(result.html, />0\|/);
  const search = await render(
    "{{search.results_count}}|{{search.results}}",
    snapshot,
    "/search?q=Matrix",
  );
  assert.ok(
    search.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
  assert.doesNotMatch(search.html, />0\|/);
});

test("native serialization omits unknown stock and previews and diagnoses consumed fields", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  assert.ok(product);
  product.media = [
    ...product.images.map((image) => ({ mediaType: "image" as const, file: image.file })),
    { mediaType: "external_video", alt: "video", host: "youtube", externalId: "recorded-id" },
  ];
  const result = await render(
    `{% assign p = all_products['${product.handle}'] %}{{p | structured_data}}|{{p.media.last | json}}|{{p.variants.first | json}}`,
    snapshot,
  );
  assert.doesNotMatch(result.html, /OutOfStock|InStock|"preview_image":null/);
  for (const field of ["available", "preview_image", "featured_image"])
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes(field)),
      field,
    );
});

test("cart image association stays unknown but known null retains product-image fallback", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  const variant = product?.variants[0];
  assert.ok(product && variant);
  snapshot.cart.lines = [{ productHandle: product.handle, variantId: variant.id, quantity: 1 }];
  const result = await render("{{cart.items.first.image.src}}", snapshot);
  assert.doesNotMatch(result.html, /\/sop\/images\//);
  assert.ok(
    result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("image")),
  );
  variant.image = null;
  const known = await render("{{cart.items.first.image.src}}", snapshot);
  assert.match(known.html, /\/sop\/images\//);
});

test("availability search facets do not invent counts when search includes unknown stock", async () => {
  const snapshot = partial();
  snapshot.filters = [
    {
      id: "filter.v.availability",
      label: "Availability",
      type: "boolean",
      values: [
        { label: "In stock", value: "1" },
        { label: "Out of stock", value: "0" },
      ],
    },
  ];
  const result = await render(
    "{% for f in search.filters %}{% for v in f.values %}count={{v.count}}{% endfor %}{% endfor %}",
    snapshot,
    "/search?q=Matrix&options[unavailable_products]=show",
  );
  assert.doesNotMatch(result.html, /count=/);
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
});

test("media tags retain known sources without inventing missing preview URLs or dimensions", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  assert.ok(product);
  product.media = [
    ...product.images.map((image) => ({ mediaType: "image" as const, file: image.file })),
    {
      mediaType: "video",
      alt: "video",
      sources: [{ file: "v.mp4", format: "mp4", mimeType: "video/mp4", width: 600, height: 400 }],
    },
  ];
  const result = await render(
    `{% assign p = all_products['${product.handle}'] %}{{p.media.first | media_tag}}{{p.media.last | video_tag: image_size: '300x200'}}`,
    snapshot,
  );
  assert.doesNotMatch(result.html, /Liquid error|NaN|poster=|src="\?/);
  assert.match(result.html, /v.mp4/);
  for (const field of ["width", "height", "preview_image"])
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes(field)),
      field,
    );
});

test("shared image metadata accepts unknown dimensions and rejects conflicting known dimensions", () => {
  const snapshot = parseSnapshot(JSON.stringify(defaultFixture()));
  const product = snapshot.products[0];
  const image = product?.images[0];
  assert.ok(product && image);
  snapshot.products = [product];
  snapshot.collections = [];
  snapshot.blogs = [];
  snapshot.cart.lines = [];
  snapshot.images = [{ ...image, filename: "test.png" }];
  Reflect.deleteProperty(image, "width");
  validateSnapshotReferences(snapshot);
  assert.equal(image.width, undefined);
  image.width = (snapshot.images[0]?.width ?? 0) + 1;
  assert.throws(() => validateSnapshotReferences(snapshot), /Conflicting image metadata/);
});

test("article structured data and selected variant events diagnose omitted source fields", async () => {
  const snapshot = partial();
  const blog = snapshot.blogs[0];
  const article = blog?.articles[0];
  const product = snapshot.products[0];
  const variant = product?.variants[0];
  assert.ok(blog && article && product && variant);
  const result = await render(
    "{{article | structured_data}}",
    snapshot,
    `/blogs/${blog.handle}/${article.handle}`,
  );
  for (const field of ["image", "published_at", "name"])
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes(field)),
      field,
    );
  const event = await render(
    "{{product | standard_event_data: 'view'}}",
    snapshot,
    `/products/${product.handle}?variant=${variant.id}`,
  );
  assert.doesNotMatch(event.html, /availableForSale/);
  assert.ok(
    event.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("available")),
  );
});
