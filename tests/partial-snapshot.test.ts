import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { validateSnapshotReferences } from "../packages/data/src/scenarios.js";
import { completeSnapshotSchema, parseSnapshot } from "../packages/data/src/schema.js";
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

async function render(
  text: string,
  snapshot = partial(),
  path = "/",
  extraFiles: Record<string, string> = {},
) {
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
      ...extraFiles,
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

test("uncaptured resource metafields stay absent and diagnose only when read", async () => {
  const source = defaultFixture();
  for (const product of source.products) Reflect.deleteProperty(product, "metafields");
  for (const page of source.pages) Reflect.deleteProperty(page, "metafields");
  for (const blog of source.blogs) {
    Reflect.deleteProperty(blog, "metafields");
    for (const article of blog.articles) Reflect.deleteProperty(article, "metafields");
  }
  assert.equal(completeSnapshotSchema.safeParse(source).success, false);
  const snapshot = parseSnapshot(JSON.stringify(source));
  const product = snapshot.products[0],
    page = snapshot.pages[0],
    blog = snapshot.blogs[0];
  assert.ok(product && page && blog);
  assert.equal(Object.hasOwn(product, "metafields"), false);
  assert.equal(Object.hasOwn(page, "metafields"), false);
  const result = await render(
    `{{ collections.all.products.first.metafields.custom.x }}
{{ pages['${page.handle}'].metafields.custom.x }}
{{ blogs['${blog.handle}'].metafields.custom.x }}
{{ blogs['${blog.handle}'].articles.first.metafields.custom.x }}`,
    snapshot,
  );
  const messages = result.diagnostics
    .filter((d) => d.code === "missing-resource")
    .map((d) => d.message);
  for (const type of ["product", "page", "blog", "article"])
    assert.ok(
      messages.some((message) => message.includes(`${type}.metafields`)),
      type,
    );
  assert.ok(
    !result.diagnostics.some((d) => d.code === "liquid-error" || d.code === "not-implemented"),
  );
  const unread = await render("<h1>Captured title</h1>", snapshot);
  assert.deepEqual(unread.diagnostics, []);
  assert.deepEqual(snapshot, source);
});

test("known empty resource metafields remain known empty without missing-data diagnostics", async () => {
  const snapshot = defaultFixture();
  for (const product of snapshot.products) product.metafields = {};
  const result = await render("{{ collections.all.products.first.metafields.custom.x }}", snapshot);
  assert.deepEqual(result.diagnostics, []);
});

test("filtering on uncaptured metafields keeps membership and counts unknown", async () => {
  const source = defaultFixture();
  for (const product of source.products) Reflect.deleteProperty(product, "metafields");
  source.filters = [
    {
      id: "filter.p.m.custom.flag",
      label: "Flag",
      type: "boolean",
      values: [{ label: "Yes", value: "1" }],
    },
  ];
  const result = await render(
    "{{ collection.products.size }}|{{ collection.products_count }}",
    parseSnapshot(JSON.stringify(source)),
    "/collections/all?filter.p.m.custom.flag=1",
  );
  assert.ok(result.diagnostics.some((d) => d.code === "missing-resource"));
  assert.ok(!result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.doesNotMatch(result.html, />0\|0</);
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
  const menu = snapshot.menus.find((value) => value.handle === "main-menu");
  assert.ok(menu);
  menu.links.push({
    title: "Uncaptured",
    type: "product_link",
    url: "/products/uncaptured",
    links: [],
  });
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
{% for link in linklists.main-menu.links %}{{link.object.title}}{% endfor %}`,
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
    "/search?q=Matrix&options[unavailable_products]=hide",
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
  assert.doesNotMatch(result.html, /count=\d/);
  assert.ok(
    result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("count")),
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

test("named collection availability facets depend only on its own members", async () => {
  const snapshot = parseSnapshot(JSON.stringify(defaultFixture()));
  const member = snapshot.products[0],
    unrelated = snapshot.products[1],
    collection = snapshot.collections[0];
  assert.ok(member && unrelated && collection);
  collection.products = [member.handle];
  for (const variant of member.variants) variant.available = true;
  for (const variant of unrelated.variants) Reflect.deleteProperty(variant, "available");
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
    "{% for f in collection.filters %}{% for v in f.values %}{{v.label}}={{v.count}};{% endfor %}{% endfor %}",
    snapshot,
    `/collections/${collection.handle}`,
  );
  assert.match(result.html, /In stock=1/);
  assert.ok(
    !result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
  Reflect.deleteProperty(member.variants[0] ?? {}, "available");
  const unknown = await render(
    "{{collection.filters.first.values.last.count}}",
    snapshot,
    `/collections/${collection.handle}`,
  );
  assert.ok(
    unknown.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("count")),
  );
});

test("nested image URL diagnostics identify the filter invocation line", async () => {
  const result = await render(
    "{% if true %}\n\n{{all_products['sop-matrix-needle'].images.first | image_url: width: 300}}\n{% endif %}",
  );
  const missing = result.diagnostics.find(
    (d) => d.code === "missing-resource" && d.message.includes("cannot be clamped"),
  );
  assert.ok(missing);
  assert.equal(missing.file, "sections/partial.liquid");
  assert.equal(missing.line, 3);
});

test("search facets ignore unavailable metadata outside the matching products", async () => {
  const snapshot = parseSnapshot(JSON.stringify(defaultFixture()));
  const unrelated = snapshot.products[1];
  assert.ok(unrelated);
  for (const variant of unrelated.variants) Reflect.deleteProperty(variant, "available");
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
    "{% for f in search.filters %}{% for v in f.values %}{{v.label}}={{v.count}};{% endfor %}{% endfor %}",
    snapshot,
    "/search?q=Matrix&options[unavailable_products]=show",
  );
  assert.match(result.html, /In stock=1/);
  assert.ok(
    !result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
});

test("nested native media, JSON and event diagnostics identify the consuming filter", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  const variant = product?.variants[0];
  assert.ok(product && variant);
  product.media = [
    ...product.images.map((image) => ({ mediaType: "image" as const, file: image.file })),
    {
      mediaType: "video",
      alt: "video",
      sources: [{ file: "v.mp4", format: "mp4", mimeType: "video/mp4", width: 600, height: 400 }],
    },
  ];
  for (const expression of [
    "product.media.first | media_tag",
    "product.media.last | video_tag",
    "product.media.last | json",
    "product | standard_event_data: 'view'",
  ]) {
    const result = await render(
      `{% if true %}\n\n{{${expression}}}\n{% endif %}`,
      snapshot,
      `/products/${product.handle}?variant=${variant.id}`,
    );
    const missing = result.diagnostics.filter((d) => d.code === "missing-resource");
    assert.ok(missing.length, expression);
    for (const diagnostic of missing) {
      assert.equal(diagnostic.file, "sections/partial.liquid", expression);
      assert.equal(diagnostic.line, 3, `${expression}: ${diagnostic.message}`);
    }
  }
});

test("nested native serializers attribute derived collection omissions to their callsite", async () => {
  const snapshot = partial();
  const collection = snapshot.collections[0];
  assert.ok(collection);
  for (const expression of ["collection | json", "collection | standard_event_data: 'view'"]) {
    const result = await render(
      `{% if true %}\n\n{{${expression}}}\n{% endif %}`,
      snapshot,
      `/collections/${collection.handle}`,
    );
    const missing = result.diagnostics.filter((d) => d.code === "missing-resource");
    assert.ok(missing.length, expression);
    for (const diagnostic of missing) assert.equal(diagnostic.line, 3, diagnostic.message);
  }
});

test("search availability checks apply after query and resource-type matching", async () => {
  const snapshot = partial();
  const page = snapshot.pages[0];
  const product = snapshot.products[0];
  assert.ok(page && product);
  page.title = "UniquePageNeedle";
  page.bodyHtml = "Known page";
  const pageResult = await render(
    "{{search.results_count}}|{{search.results.first.title}}",
    snapshot,
    "/search?q=UniquePageNeedle&type=page",
  );
  assert.match(pageResult.html, /1\|UniquePageNeedle/);
  assert.ok(
    !pageResult.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
  for (const variant of product.variants) variant.available = true;
  const productResult = await render(
    "{{search.results_count}}|{{search.results.first.title}}",
    snapshot,
    "/search?q=Matrix&type=product",
  );
  assert.match(productResult.html, /1\|SOP Matrix Needle/);
  assert.ok(
    !productResult.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
  for (const variant of product.variants) variant.available = false;
  Reflect.deleteProperty(product.variants[0] ?? {}, "available");
  const unknown = await render(
    "{{search.results.size}}",
    snapshot,
    "/search?q=Matrix&type=product&options[unavailable_products]=hide",
  );
  assert.ok(
    unknown.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
});

test("search keeps unknown matched stock distinct across hide, last and show modes", async () => {
  const snapshot = partial();
  for (const mode of ["hide"]) {
    const result = await render(
      "count={{search.results.size}}",
      snapshot,
      `/search?q=Matrix&type=product&options[unavailable_products]=${mode}`,
    );
    assert.doesNotMatch(result.html, /count=0|count=1/);
    assert.ok(
      result.diagnostics.some(
        (d) => d.code === "missing-resource" && d.message.includes("available"),
      ),
    );
  }
  const shown = await render(
    "count={{search.results_count}}",
    snapshot,
    "/search?q=Matrix&type=product&options[unavailable_products]=show",
  );
  assert.match(shown.html, /count=1/);
  const empty = await render("count={{search.results_count}}", snapshot, "/search?q=");
  assert.match(empty.html, /count=0/);
  assert.ok(
    !empty.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
});

test("known available variants establish product and search availability despite unknown siblings", async () => {
  for (const knownIndex of [0, 1]) {
    const snapshot = partial();
    const product = snapshot.products[0];
    assert.ok(product && product.variants.length >= 2);
    const known = product.variants[knownIndex];
    assert.ok(known);
    known.available = true;
    const productResult = await render(
      "available={{product.available}}",
      snapshot,
      `/products/${product.handle}`,
    );
    assert.match(productResult.html, /available=true/);
    assert.ok(
      !productResult.diagnostics.some(
        (d) => d.code === "missing-resource" && d.message.includes("available"),
      ),
    );
    for (const mode of ["hide", "last", "show"]) {
      const result = await render(
        "count={{search.results_count}}|available={{search.results.first.available}}",
        snapshot,
        `/search?q=Matrix&type=product&options[unavailable_products]=${mode}`,
      );
      assert.match(result.html, /count=1\|available=true/);
      assert.ok(
        !result.diagnostics.some(
          (d) => d.code === "missing-resource" && d.message.includes("available"),
        ),
      );
    }
  }
});

test("known first available variant survives later unknown availability", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  assert.ok(product && product.variants[0]);
  product.variants[0].available = true;
  const result = await render(
    "{{product.first_available_variant.id}}|{{product.selected_or_first_available_variant.id}}",
    snapshot,
    `/products/${product.handle}`,
  );
  const id = product.variants[0].id.split("/").at(-1);
  assert.ok(result.html.includes(`${id}|${id}`));
  assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
});

test("option availability uses relevant variants and a known selected context", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  assert.ok(product && product.variants[0]);
  product.variants[0].available = true;
  const result = await render(
    "{% for option in product.options_with_values %}{% for value in option.values %}{% if value.selected %}{{value.available}}|{% endif %}{% endfor %}{% endfor %}",
    snapshot,
    `/products/${product.handle}`,
  );
  assert.ok(result.html.includes("true|".repeat(product.options.length)));
  assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
});

test("known image attachment remains true with an unknown sibling association", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  assert.ok(product && product.variants[0] && product.images[0]);
  product.variants[0].image = product.images[0].file;
  const result = await render(
    "{{product.images.first.attached_to_variant?}}",
    snapshot,
    `/products/${product.handle}`,
  );
  assert.match(result.html, />true<\/div>/);
  assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
});

test("collection availability membership accepts a known match despite unknown siblings", async () => {
  for (const available of [true, false]) {
    const snapshot = partial();
    const product = snapshot.products[0],
      collection = snapshot.collections[0];
    assert.ok(product && product.variants[0] && collection);
    product.variants[0].available = available;
    collection.products = [product.handle];
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
      "{{collection.products.size}}|{{collection.products.first.handle}}",
      snapshot,
      `/collections/${collection.handle}?filter.v.availability=${available ? 1 : 0}`,
    );
    assert.ok(result.html.includes(`1|${product.handle}`));
    assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
  }
});

test("collection combines unknown stock with decisive filter alternatives and exclusions", async () => {
  const snapshot = partial();
  const product = snapshot.products[0],
    collection = snapshot.collections[0];
  assert.ok(product && collection);
  collection.products = [product.handle];
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
    {
      id: "filter.p.vendor",
      label: "Vendor",
      type: "list",
      values: [{ label: "NoMatch", value: "NoMatch" }],
    },
  ];
  for (const [query, count] of [
    ["filter.v.availability=1&filter.v.availability=0", 1],
    ["filter.v.availability=1&filter.p.vendor=NoMatch", 0],
  ] as const) {
    const result = await render(
      "count={{collection.products.size}}|{{collection.products_count}}",
      snapshot,
      `/collections/${collection.handle}?${query}`,
    );
    assert.ok(result.html.includes(`count=${count}|${count}`));
    assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
  }
});

test("facets preserve known counts and omit only undecidable sibling counts", async () => {
  const snapshot = partial();
  const product = snapshot.products[0],
    collection = snapshot.collections[0];
  assert.ok(product && collection && product.variants[0]);
  snapshot.products = [product];
  product.variants[0].available = true;
  collection.products = [product.handle];
  snapshot.filters = [
    {
      id: "filter.v.availability",
      label: "Stock",
      type: "boolean",
      values: [
        { label: "In", value: "1" },
        { label: "Out", value: "0" },
      ],
    },
    {
      id: "filter.p.vendor",
      label: "Vendor",
      type: "list",
      values: [{ label: "Vendor", value: product.vendor }],
    },
  ];
  for (const [path, field] of [
    [`/collections/${collection.handle}`, "collection.filters"],
    ["/collections/all", "collection.filters"],
    ["/search?q=Matrix&options[unavailable_products]=show", "search.filters"],
  ]) {
    const result = await render(
      `{% for f in ${field} %}{% for v in f.values %}{{v.label}}={{v.count}};{% endfor %}{% endfor %}`,
      snapshot,
      path,
    );
    assert.match(result.html, /In=1;Out=;Vendor=1;/);
    assert.ok(
      result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("count")),
    );
  }
});

test("unknown facet counts identify nested property access and labels do not consume membership", async () => {
  const snapshot = partial();
  const product = snapshot.products[0],
    collection = snapshot.collections[0];
  assert.ok(product && collection);
  collection.products = [product.handle];
  snapshot.filters = [
    {
      id: "filter.v.availability",
      label: "Stock",
      type: "boolean",
      values: [{ label: "In", value: "1" }],
    },
  ];
  const path = `/collections/${collection.handle}`;
  for (const snippet of [false, true]) {
    const text = "{% if true %}\n\n{{collection.filters.first.values.first.count}}\n{% endif %}";
    const result = await render(
      snippet ? "{% render 'facet', collection: collection %}" : text,
      snapshot,
      path,
      snippet ? { "snippets/facet.liquid": text } : {},
    );
    const missing = result.diagnostics.filter((d) => d.code === "missing-resource");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.line, 3);
    assert.equal(missing[0]?.file, snippet ? "snippets/facet.liquid" : "sections/partial.liquid");
  }
  const labels = await render(
    "{% for f in collection.filters %}{{f.label}};{% endfor %}",
    snapshot,
    `${path}?filter.v.availability=1`,
  );
  assert.match(labels.html, /Stock;/);
  assert.ok(!labels.diagnostics.some((d) => d.code === "missing-resource"));
  const members = await render(
    "{{collection.products_count}}",
    snapshot,
    `${path}?filter.v.availability=1`,
  );
  assert.ok(members.diagnostics.some((d) => d.code === "missing-resource"));
});

test("facet labels and product counts do not consume localized sort inputs", async () => {
  const snapshot = partial();
  const product = snapshot.products[0],
    collection = snapshot.collections[0];
  assert.ok(product && collection);
  collection.products = snapshot.products.slice(0, 2).map((value) => value.handle);
  assert.equal(collection.products.length, 2);
  snapshot.filters = [
    {
      id: "filter.p.vendor",
      label: "Vendor",
      type: "list",
      values: [{ label: product.vendor, value: product.vendor }],
    },
  ];
  const path = `/collections/${collection.handle}?sort_by=title-descending`;
  const labels = await render(
    "{% for f in collection.filters %}{{f.label}};{% endfor %}|{{collection.products_count}}",
    snapshot,
    path,
  );
  assert.match(labels.html, /Vendor;\|2/);
  assert.ok(!labels.diagnostics.some((d) => d.code === "missing-resource"));
  const products = await render(
    "{% assign f = collection.filters %}\n\n{{collection.products.first.title}}",
    snapshot,
    path,
  );
  const missing = products.diagnostics.filter((d) => d.code === "missing-resource");
  assert.equal(missing.length, 1);
  assert.ok(missing[0]?.message.includes("locale"));
  assert.equal(missing[0]?.line, 3);
});

test("search counts and known facets survive unknown availability used only for ordering", async () => {
  const snapshot = partial();
  const product = snapshot.products[0];
  assert.ok(product);
  snapshot.filters = [
    {
      id: "filter.p.vendor",
      label: "Vendor",
      type: "list",
      values: [{ label: product.vendor, value: product.vendor }],
    },
  ];
  const path = "/search?q=Matrix&type=product";
  const result = await render(
    "{{search.results_count}}|{% for f in search.filters %}{{f.label}}:{{f.values.first.count}}{% endfor %}",
    snapshot,
    path,
  );
  assert.match(result.html, /1\|Vendor:1/);
  assert.ok(
    !result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
  const second = snapshot.products[1];
  assert.ok(second);
  second.title = "Second Matrix result";
  const ordered = await render(
    "{% if true %}\n\n{{search.results.first.title}}\n{% endif %}",
    snapshot,
    path,
  );
  assert.ok(
    ordered.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available") && d.line === 3,
    ),
  );
});

test("unused translated schema defaults do not consume absent locale", async () => {
  const schema =
    '{% schema %}{"settings":[{"type":"text","id":"heading","default":"t:heading"}]}{% endschema %}';
  const files = { "locales/en.default.schema.json": '{"heading":"Invented heading"}' };
  const unused = await render(`Known text${schema}`, partial(), "/", files);
  assert.ok(!unused.diagnostics.some((d) => d.code === "missing-resource"));
  const used = await render(
    `{% if true %}\n\n{{section.settings.heading}}\n{% endif %}${schema}`,
    partial(),
    "/",
    files,
  );
  assert.doesNotMatch(used.html, /Invented heading|t:heading/);
  assert.ok(
    used.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("locale") && d.line === 3,
    ),
  );
});

test("page_image preserves omitted resource images instead of choosing a shop fallback", async () => {
  const snapshot = partial();
  const collection = snapshot.collections[0],
    image = snapshot.products[0]?.images[0];
  assert.ok(collection && image);
  snapshot.shop.socialSharingImage = { file: image.file, alt: image.alt };
  const unknown = await render(
    "{% if true %}\n\n{{page_image.file}}\n{% endif %}",
    snapshot,
    `/collections/${collection.handle}`,
  );
  assert.ok(!unknown.html.includes(image.file));
  assert.ok(
    unknown.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("image") && d.line === 3,
    ),
  );
  collection.image = null;
  const known = await render("{{page_image.file}}", snapshot, `/collections/${collection.handle}`);
  assert.ok(known.html.includes(image.file));
  assert.ok(!known.diagnostics.some((d) => d.code === "missing-resource"));
});

test("automatic collection featured image does not invent locale-dependent first product", async () => {
  const snapshot = partial();
  assert.ok(snapshot.products.length > 1);
  const result = await render(
    "{% if true %}\n\n{{collections.all.featured_image.file}}\n{% endif %}",
    snapshot,
  );
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("locale") && d.line === 3,
    ),
  );
  for (const product of snapshot.products)
    for (const image of product.images) assert.ok(!result.html.includes(image.file));
});

test("search last ordering retains exactly the order shared by every stock completion", async () => {
  const { searchResults } = await import("../packages/data/src/search.js");
  for (const a of [true, false, undefined])
    for (const b of [true, false, undefined])
      for (const c of [true, false, undefined]) {
        const values = [a, b, c];
        const candidates = values.map((available, value) => ({
          type: "product" as const,
          value,
          text: "needle",
          available,
          price: value,
        }));
        const completions: number[][] = [];
        const unknowns = values.filter((v) => v === undefined).length;
        for (let mask = 0; mask < 2 ** unknowns; mask++) {
          let bit = 0;
          const complete = candidates.map((candidate) => ({
            ...candidate,
            available: candidate.available ?? Boolean(mask & (1 << bit++)),
          }));
          completions.push(
            searchResults(
              complete,
              "/search?q=needle&sort_by=price-ascending",
              () => {},
              () => {},
            )?.map((v) => v.value) ?? [],
          );
        }
        const expected = completions.every(
          (value) => JSON.stringify(value) === JSON.stringify(completions[0]),
        )
          ? completions[0]
          : undefined;
        const actual = searchResults(
          candidates,
          "/search?q=needle&sort_by=price-ascending",
          () => {},
          () => {},
        );
        assert.deepEqual(
          actual?.map((v) => v.value),
          expected,
          JSON.stringify(values),
        );
      }
  const snapshot = partial();
  const singleton = await render(
    "{{search.results_count}}|{{search.results.first.title}}",
    snapshot,
    "/search?q=Matrix&type=product",
  );
  assert.match(singleton.html, /1\|SOP Matrix Needle/);
  assert.ok(!singleton.diagnostics.some((d) => d.code === "missing-resource"));
});

test("search page title never invents a count when hide membership is unknown", async () => {
  const snapshot = partial();
  snapshot.shop.locale = "en";
  const result = await render(
    "{{page_title}}",
    snapshot,
    "/search?q=Matrix&type=product&options[unavailable_products]=hide",
  );
  assert.doesNotMatch(result.html, /NaN|results found/);
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("available"),
    ),
  );
});

test("automatic collection featured image remains known null when every product has no image", async () => {
  const snapshot = partial();
  for (const product of snapshot.products) {
    product.images = [];
    product.media = [];
    for (const variant of product.variants) variant.image = null;
  }
  const result = await render(
    "{% if collections.all.featured_image == nil %}known-none{% endif %}",
    snapshot,
  );
  assert.match(result.html, /known-none/);
  assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
});

test("search cap ignores irrelevant stock uncertainty and distinguishes membership from order", async () => {
  const { searchResults } = await import("../packages/data/src/search.js");
  for (const mode of ["last", "hide"])
    for (const prefix of [998, 1000]) {
      const stock: (boolean | undefined)[] = [
        ...Array.from({ length: prefix }, () => true),
        undefined,
        undefined,
        false,
        false,
      ];
      const candidates = stock.map((available, value) => ({
        type: "product" as const,
        value,
        text: "needle",
        available,
        price: value,
      }));
      const path = `/search?q=needle&sort_by=price-ascending&options[unavailable_products]=${mode}`;
      const completions = Array.from({ length: 4 }, (_, mask) => {
        let bit = 0;
        return (
          searchResults(
            candidates.map((v) => ({
              ...v,
              available: v.available ?? Boolean(mask & (1 << bit++)),
            })),
            path,
            () => {},
            () => {},
          )?.map((v) => v.value) ?? []
        );
      });
      for (const purpose of ["results", "count", "facets"] as const) {
        const canonical = (values: number[]) =>
          purpose === "count"
            ? values.length
            : purpose === "facets"
              ? [...values].sort((a, b) => a - b)
              : values;
        const values = completions.map(canonical);
        const expected = values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]))
          ? values[0]
          : undefined;
        const actual = searchResults(
          candidates,
          path,
          () => {},
          () => {},
          purpose,
        );
        assert.deepEqual(
          actual === undefined ? undefined : canonical(actual.map((v) => v.value)),
          expected,
          `${mode}/${prefix}/${purpose}`,
        );
      }
    }
});

test("known empty collections and product-free searches need no filter metadata", async () => {
  const snapshot = partial(),
    collection = snapshot.collections[0];
  assert.ok(collection);
  collection.products = [];
  for (const path of [
    `/collections/${collection.handle}`,
    `/collections/${collection.handle}?filter.v.availability=1`,
  ]) {
    const result = await render(
      "{{collection.filters.size}}|{{collection.products_count}}",
      snapshot,
      path,
    );
    assert.match(result.html, /0\|0/);
    assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
  }
  for (const path of ["/search?q=absentuniqueneedle", "/search?q=Matrix&type=page", "/search?q="]) {
    const result = await render("{{search.filters.size}}", snapshot, path);
    assert.match(result.html, />0<\/div>/);
    assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
  }
  snapshot.products = [];
  for (const c of snapshot.collections) c.products = [];
  const all = await render(
    "{{collections.all.filters.size}}|{{collections.all.products_count}}|{{collections.all.products.size}}",
    snapshot,
    "/collections/all?filter.v.availability=1",
  );
  assert.match(all.html, /0\|0\|0/);
  assert.ok(!all.diagnostics.some((d) => d.code === "missing-resource"));
});

test("menu objects use known type and URL before requiring an omitted handle", async () => {
  const snapshot = partial(),
    menu = snapshot.menus[0],
    product = snapshot.products[0];
  assert.ok(menu && product);
  menu.links = [{ title: "External", type: "http_link", url: "https://example.com", links: [] }];
  const external = await render(
    `{% if linklists['${menu.handle}'].links.first.object == nil %}known-none{% endif %}`,
    snapshot,
  );
  assert.match(external.html, /known-none/);
  assert.ok(!external.diagnostics.some((d) => d.code === "missing-resource"));
  const link = menu.links[0];
  assert.ok(link);
  link.type = "product_link";
  link.url = `/products/${product.handle}`;
  const known = await render(`{{linklists['${menu.handle}'].links.first.object.title}}`, snapshot);
  assert.ok(known.html.includes(product.title));
  assert.ok(!known.diagnostics.some((d) => d.code === "missing-resource"));
  link.url = "/products/uncaptured";
  const unknown = await render(
    `{% if true %}\n\n{{linklists['${menu.handle}'].links.first.object}}\n{% endif %}`,
    snapshot,
  );
  assert.ok(
    unknown.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("resourceHandle") && d.line === 3,
    ),
  );
});

test("empty and singleton title ordering needs no locale", async () => {
  const snapshot = partial(),
    collection = snapshot.collections[0],
    product = snapshot.products[0];
  assert.ok(collection && product);
  for (const handles of [[], [product.handle]]) {
    collection.products = handles;
    const result = await render(
      "{{collection.products.size}}",
      snapshot,
      `/collections/${collection.handle}?sort_by=title-descending`,
    );
    assert.ok(result.html.includes(`>${handles.length}</div>`));
    assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
  }
});

test("automatic collection order uses the filtered result size", async () => {
  const snapshot = partial(),
    product = snapshot.products[0];
  assert.ok(product);
  product.vendor = "UniqueVendor";
  snapshot.filters = [
    {
      id: "filter.p.vendor",
      label: "Vendor",
      type: "list",
      values: [{ label: "UniqueVendor", value: "UniqueVendor" }],
    },
  ];
  for (const [vendor, count] of [
    ["UniqueVendor", 1],
    ["NoMatch", 0],
  ] as const) {
    const result = await render(
      "{{collection.products_count}}|{{collection.products.size}}",
      snapshot,
      `/collections/all?sort_by=title-descending&filter.p.vendor=${vendor}`,
    );
    assert.ok(result.html.includes(`>${count}|${count}</div>`));
    assert.ok(!result.diagnostics.some((d) => d.code === "missing-resource"));
  }
});

test("shared image filters retain captured dimensions across partial references", async () => {
  for (const knownFirst of [true, false]) {
    const snapshot = parseSnapshot(JSON.stringify(defaultFixture()));
    const image = snapshot.products[0]?.images[0];
    assert.ok(image);
    const width = image.width;
    const height = image.height;
    assert.ok(width && height);
    snapshot.images = [{ ...image, filename: "shared.png" }];
    const uploaded = snapshot.images[0];
    assert.ok(uploaded);
    Reflect.deleteProperty(uploaded, "mediaId");
    Reflect.deleteProperty(knownFirst ? uploaded : image, "width");
    Reflect.deleteProperty(knownFirst ? image : uploaded, "height");
    validateSnapshotReferences(snapshot);
    const before = JSON.stringify(snapshot);
    const result = await render(
      `{{all_products['${snapshot.products[0]?.handle}'].images.first | image_url: width: 5760 | image_tag}}`,
      snapshot,
    );
    assert.ok(result.html.includes(`width=${width}`), result.html);
    assert.ok(result.html.includes(`width="${width}" height="${height}"`), result.html);
    assert.ok(
      !result.diagnostics.some(
        (d) => d.code === "missing-resource" && /\.(width|height)/.test(d.message),
      ),
      JSON.stringify(result.diagnostics),
    );
    assert.equal(JSON.stringify(snapshot), before);
  }
});

test("unit price without a measurement does not consume money formatting", async () => {
  const result = await render(
    "[{{123 | unit_price_with_measurement: nil}}][{{123 | unit_price_with_measurement: absent}}]",
  );
  assert.match(result.html, /\[\]\[\]/);
  assert.ok(
    !result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("money_format"),
    ),
    JSON.stringify(result.diagnostics),
  );
});

test("date passthroughs do not consume locale", async () => {
  for (const format of ["nil", "''", "absent"]) {
    const result = await render(`{{'2026-10-22' | date: ${format}}}`);
    assert.match(result.html, /2026-10-22/);
    assert.ok(
      !result.diagnostics.some(
        (d) => d.code === "missing-resource" && d.message.includes("locale"),
      ),
      JSON.stringify(result.diagnostics),
    );
  }
});

test("time tag passthrough uses known ISO datetime but diagnoses requested formatting", async () => {
  const result = await render("{{'2026-10-22' | time_tag: nil}}");
  assert.match(result.html, /<time datetime="[^"]+">2026-10-22<\/time>/);
  assert.ok(
    !result.diagnostics.some((d) => d.code === "missing-resource" && d.message.includes("locale")),
    JSON.stringify(result.diagnostics),
  );
  const formatted = await render("{{'2026-10-22' | time_tag: nil, datetime: '%B'}}");
  assert.ok(
    formatted.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("locale"),
    ),
  );
});

test("a singleton blog article needs no publication order", async () => {
  const snapshot = partial();
  const blog = snapshot.blogs[0];
  const article = blog?.articles[0];
  assert.ok(blog);
  assert.ok(article);
  blog.articles = [article];
  const result = await render(`{{blogs['${blog.handle}'].articles.first.title}}`, snapshot);
  assert.ok(result.html.includes(article.title), result.html);
  assert.ok(
    !result.diagnostics.some(
      (d) => d.code === "missing-resource" && d.message.includes("articles order"),
    ),
    JSON.stringify(result.diagnostics),
  );
});

test("known non-English date passthrough retains complete-input diagnostics", async () => {
  const snapshot = parseSnapshot(JSON.stringify(defaultFixture()));
  snapshot.shop.locale = "fr-CA";
  for (const filter of ["date", "time_tag"]) {
    for (const format of ["nil", "absent"]) {
      for (const value of ["'2026-10-22'", "'now'"]) {
        const result = await render(`{{${value} | ${filter}: ${format}}}`, snapshot);
        assert.ok(
          result.diagnostics.some(
            (d) =>
              d.code === "not-implemented" && d.message.includes("Localized system date formats"),
          ),
          JSON.stringify(result.diagnostics),
        );
      }
    }
  }
});

test("automatic collection explicit ordering needs locale only for unresolved title ties", async () => {
  for (const order of [
    "price-ascending",
    "price-descending",
    "created-ascending",
    "created-descending",
  ]) {
    for (const tied of [false, true]) {
      const snapshot = parseSnapshot(JSON.stringify(defaultFixture()));
      Reflect.deleteProperty(snapshot.shop, "locale");
      snapshot.products.forEach((product, index) => {
        for (const variant of product.variants) variant.price = `${tied ? 1 : index + 1}.00`;
        product.createdAt = new Date(Date.UTC(2026, 0, tied ? 1 : index + 1)).toISOString();
      });
      const result = await render(
        "{{collection.products.size}}",
        snapshot,
        `/collections/all?sort_by=${order}`,
      );
      assert.equal(
        result.diagnostics.some(
          (d) =>
            d.code === "missing-resource" && d.message.includes("collections.all product order"),
        ),
        tied,
        JSON.stringify(result.diagnostics),
      );
    }
  }
});

test("unviewed automatic collection retains its localized base order requirement", async () => {
  const snapshot = parseSnapshot(JSON.stringify(defaultFixture()));
  Reflect.deleteProperty(snapshot.shop, "locale");
  snapshot.products.forEach((product, index) => {
    for (const variant of product.variants) variant.price = `${index + 1}.00`;
    product.createdAt = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
  });
  for (const path of [
    "/?sort_by=price-ascending",
    "/collections/sop-catalog?sort_by=created-descending",
  ]) {
    const result = await render("{{collections.all.products.first.handle}}", snapshot, path);
    assert.ok(
      result.diagnostics.some(
        (d) => d.code === "missing-resource" && d.message.includes("collections.all product order"),
      ),
      JSON.stringify(result.diagnostics),
    );
  }
});
