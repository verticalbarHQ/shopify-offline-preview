import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import type { Snapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { FixtureRenderSource } from "./helpers/render-source.js";

function fixture(count = 301): Snapshot {
  const snapshot = defaultFixture(),
    first = snapshot.products[0];
  assert.ok(first);
  snapshot.products = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(first),
    id: String(index + 1000),
    handle: `product-${index}`,
    title: `Product ${String(index).padStart(3, "0")}`,
    variants: first.variants.map((variant, position) => ({
      ...structuredClone(variant),
      id: `variant-${index}-${position}`,
    })),
  }));
  snapshot.collections = [
    {
      handle: "featured",
      title: "Featured",
      descriptionHtml: "",
      image: null,
      products: snapshot.products.map((value) => value.handle),
      sortOrder: "manual",
      templateSuffix: null,
    },
  ];
  snapshot.cart.lines = [];
  snapshot.menus = [];
  return snapshot;
}
function theme(body: string) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{ content_for_layout }}",
    "templates/index.liquid": body,
    "snippets/unused.liquid": "unused",
    "sections/unused.liquid": "unused",
  });
}
for (const [name, body, reads] of [
  ["counts", "{{ shop.products_count }}:{{ collections.featured.all_products_count }}", 0],
  [
    "limit",
    "{% for item in collections.featured.products limit: 4 %}{{ item.title }};{% endfor %}",
    4,
  ],
  [
    "offset",
    "{% for item in collections.featured.products offset: 51 limit: 4 %}{{ item.title }};{% endfor %}",
    4,
  ],
  ["json", "{{ collections.featured.products | slice: 0, 4 | json }}", 4],
  [
    "sort",
    "{% assign sorted = collections.featured.products | sort: 'title' %}{{ sorted.first.title }}",
    301,
  ],
  ["lookup", "{{ all_products['product-250'].title }}", 1],
] as const)
  test(`source preserves ${name} output with only demanded product bodies`, async () => {
    const snapshot = fixture(),
      source = new FixtureRenderSource(snapshot),
      files = theme(body),
      paths: string[] = [];
    const read = files.readText.bind(files);
    files.readText = async (path) => {
      paths.push(path);
      return read(path);
    };
    const lazy = await renderTheme(files, "/", {
      source,
      staticPreview: true,
      backupPreview: { standardMoneyFormat: true },
    });
    const full = await renderTheme(theme(body), "/", {
      snapshot,
      backupPreview: { standardMoneyFormat: true },
    });
    assert.equal(lazy.html, full.html);
    assert.equal(source.reads.flat().filter((value) => value.kind === "product").length, reads);
    assert.equal(paths.includes("snippets/unused.liquid"), false);
    assert.equal(paths.includes("sections/unused.liquid"), false);
    assert.equal(
      lazy.diagnostics.some((value) => value.code === "liquid-error"),
      false,
      JSON.stringify(lazy.diagnostics),
    );
  });

test("100k membership offset visits one bounded batch without reading earlier products", async () => {
  const snapshot = fixture(1),
    first = snapshot.products[0];
  assert.ok(first);
  const source = new FixtureRenderSource(snapshot),
    originalList = source.list.bind(source);
  source.list = async (query) => {
    if (query.relation !== "collection-products") return originalList(query);
    source.lists.push(query);
    return {
      state: "complete",
      total: 100_000,
      entries: Array.from({ length: query.limit }, (_, index) => ({
        ordinal: query.offset + index,
        state: "present",
        descriptor: {
          kind: "product",
          id: `product-${query.offset + index}`,
          key: `product-${query.offset + index}`,
          position: query.offset + index,
        },
      })),
    };
  };
  const originalRead = source.read.bind(source);
  source.read = async (descriptors) => {
    if (descriptors.some((value) => value.kind !== "product")) return originalRead(descriptors);
    source.reads.push([...descriptors]);
    return descriptors.map((descriptor) => ({
      kind: "product",
      value: { ...first, handle: descriptor.key, title: `Product ${descriptor.position}` },
    }));
  };
  const output = await renderTheme(
    theme(
      "{% for p in collections.featured.products offset: 99990 limit: 4 %}{{p.title}};{% endfor %}",
    ),
    "/",
    { source, staticPreview: true },
  );
  assert.equal(output.html, "Product 99990;Product 99991;Product 99992;Product 99993;");
  assert.deepEqual(
    source.lists.map((value) => [value.offset, value.limit]),
    [
      [0, 0],
      [99990, 4],
    ],
  );
  assert.deepEqual(
    source.reads.filter((values) => values[0]?.kind === "product").map((values) => values.length),
    [4],
  );
});

test("selected setting references are awaited and unused settings never read bodies", async () => {
  const snapshot = fixture(),
    source = new FixtureRenderSource(snapshot);
  const files = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.liquid":
      "{{settings.chosen.title}}:{% for p in settings.cards limit: 2 %}{{p.title}};{% endfor %}",
    "config/settings_schema.json": JSON.stringify([
      {
        name: "Choices",
        settings: [
          { type: "product", id: "chosen", label: "Chosen" },
          { type: "product", id: "unused", label: "Unused" },
          { type: "product_list", id: "cards", label: "Cards" },
        ],
      },
    ]),
    "config/settings_data.json": JSON.stringify({
      current: {
        chosen: "product-250",
        unused: "product-299",
        cards: ["product-5", "product-6", "product-7"],
      },
    }),
  });
  const output = await renderTheme(files, "/", { source, staticPreview: true });
  assert.equal(output.html, "Product 250:Product 005;Product 006;");
  assert.deepEqual(
    source.reads
      .flat()
      .filter((value) => value.kind === "product")
      .map((value) => value.key),
    ["product-250", "product-5", "product-6"],
  );
});

test("static preview loads selected literal dependencies, preserves used styles and omits scripts", async () => {
  const snapshot = fixture(1),
    source = new FixtureRenderSource(snapshot),
    batches: string[][] = [];
  const files = new MemoryThemeFileSystem({
    "layout/theme.liquid": "<head>{{content_for_header}}</head>{{content_for_layout}}",
    "templates/index.json": JSON.stringify({
      sections: { a: { type: "hero" }, off: { type: "unused", disabled: true } },
      order: ["a", "off"],
    }),
    "sections/hero.liquid":
      "{% render 'card' %}{% stylesheet %}.hero {color:red}{% endstylesheet %}{% javascript %}alert('never'){% endjavascript %}",
    "snippets/card.liquid": "hello",
    "sections/unused.liquid": "unused",
  });
  const adapter = {
    readText: files.readText.bind(files),
    readBytes: files.readBytes.bind(files),
    listFiles: files.listFiles.bind(files),
    readTexts: async (paths: readonly string[]) => {
      batches.push([...paths]);
      return new Map(
        await Promise.all(paths.map(async (path) => [path, await files.readText(path)] as const)),
      );
    },
  };
  const output = await renderTheme(adapter, "/", { source, staticPreview: true });
  assert.match(output.html, /hello/);
  assert.match(output.html, /\.hero \{color:red\}/);
  assert.doesNotMatch(output.html, /alert|data-sop-theme-scripts/);
  assert.equal(batches.flat().includes("sections/unused.liquid"), false);
  assert.equal(batches.flat().filter((path) => path === "snippets/card.liquid").length, 1);
});

for (const [name, body] of [
  ["collection iteration", "{% for c in collections limit: 1 %}{{c.title}}{% endfor %}"],
  [
    "pagination",
    "{% paginate collections.featured.products by 4 %}{{paginate.items}}:{% for p in collections.featured.products %}{{p.title}};{% endfor %}{% endpaginate %}",
  ],
  ["membership", "{{all_products['product-5'].collections.first.title}}"],
  [
    "selection",
    "{% assign found = collections.featured.products | where: 'title', 'Product 004' %}{{found.first.title}}",
  ],
  ["facets", "{{collections.featured.all_tags | json}}"],
] as const)
  test(`source preserves ${name}`, async () => {
    const snapshot = fixture(),
      source = new FixtureRenderSource(snapshot);
    const lazy = await renderTheme(theme(body), "/?page=2", { source, staticPreview: true });
    const full = await renderTheme(theme(body), "/?page=2", { snapshot });
    assert.equal(lazy.html, full.html);
    assert.equal(
      lazy.diagnostics.some((value) => value.code === "liquid-error"),
      false,
      JSON.stringify(lazy.diagnostics),
    );
  });

test("captured missing membership stays nil in its original slot and blocks reordering", async () => {
  const snapshot = fixture(3),
    collection = snapshot.collections[0];
  assert.ok(collection);
  collection.products = ["product-0", "missing", "product-2"];
  collection.missingProducts = ["missing"];
  for (const body of [
    "{% for p in collections.featured.products %}{{forloop.index}}={{p.title}};{% endfor %}",
    "{{collections.featured.products | reverse | json}}",
    "{{collections.featured.products_count}}",
  ]) {
    const lazy = await renderTheme(theme(body), "/", {
      source: new FixtureRenderSource(snapshot),
      staticPreview: true,
      backupPreview: { standardMoneyFormat: true },
    });
    const full = await renderTheme(theme(body), "/", {
      snapshot,
      backupPreview: { standardMoneyFormat: true },
    });
    assert.equal(lazy.html, full.html);
  }
});

test("unknown and known-null commercial values preserve backup nil behavior", async () => {
  const snapshot = fixture(2);
  for (const product of snapshot.products)
    for (const variant of product.variants) {
      delete variant.available;
      variant.compareAtPrice = null;
    }
  const body =
    "{% for p in collections.featured.products %}{{ p.available | default: 'unknown' }}:{{p.compare_at_price | default: 'nil'}}:{{p.title}};{% endfor %}";
  const options = { backupPreview: { standardMoneyFormat: true } };
  const lazy = await renderTheme(theme(body), "/", {
    ...options,
    source: new FixtureRenderSource(snapshot),
    staticPreview: true,
  });
  const full = await renderTheme(theme(body), "/", { ...options, snapshot });
  assert.equal(lazy.html, full.html);
});

test("cart counters read header quantities without product bodies", async () => {
  const snapshot = fixture(2),
    product = snapshot.products[0],
    variant = product?.variants[0];
  assert.ok(product && variant);
  snapshot.cart.lines = [{ productHandle: product.handle, variantId: variant.id, quantity: 3 }];
  const source = new FixtureRenderSource(snapshot),
    body = "{{cart.item_count}}:{{cart.empty?}}";
  const lazy = await renderTheme(theme(body), "/", { source, staticPreview: true });
  assert.equal(lazy.html, (await renderTheme(theme(body), "/", { snapshot })).html);
  assert.equal(source.reads.length, 0);
});

test("source failures escape inline Liquid handling and preserve typed errors", async () => {
  const source = new FixtureRenderSource(fixture(1));
  source.read = async () => {
    throw new Error("transport unavailable");
  };
  await assert.rejects(
    renderTheme(theme("{{all_products['product-0'].title}}"), "/", {
      source,
      staticPreview: true,
      liquidErrors: "omit",
    }),
    (error) =>
      error instanceof Error && "code" in error && error.code === "PREVIEW_SOURCE_READ_FAILED",
  );
});

test("abort interrupts a source that does not settle and is not swallowed by Liquid", async () => {
  const source = new FixtureRenderSource(fixture(1)),
    controller = new AbortController();
  source.read = async () => {
    controller.abort(new DOMException("selection changed", "AbortError"));
    return new Promise(() => {});
  };
  await assert.rejects(
    renderTheme(theme("{{all_products['product-0'].title}}"), "/", {
      source,
      signal: controller.signal,
      staticPreview: true,
      liquidErrors: "omit",
    }),
    { name: "AbortError" },
  );
});

for (const [path, template, body] of [
  [
    "/products/sop-matrix-needle",
    "product",
    "{{product.title}}|{{page_title}}|{{product.selected_or_first_available_variant.title}}|{{product | json}}",
  ],
  [
    "/collections/sop-catalog?sort_by=title-descending",
    "collection",
    "{{collection.products_count}}:{% for p in collection.products limit:3 %}{{p.title}};{% endfor %}",
  ],
  ["/pages/about", "page", "{{page.title}}|{{page.content}}|{{page_title}}|{{page_description}}"],
  [
    "/blogs/news/story-1",
    "article",
    "{{blog.title}}|{{article.title}}|{{article.published_at}}|{{page_title}}",
  ],
  [
    "/blogs/news",
    "blog",
    "{{blog.articles_count}}:{% for article in blog.articles limit:2 %}{{article.title}};{% endfor %}",
  ],
  [
    "/search?q=needle",
    "search",
    "{{search.results_count}}|{{page_title}}|{% for item in search.results %}{{item.title}};{% endfor %}",
  ],
  ["/cart", "cart", "{{cart.item_count}}|{{cart.total_price}}|{{cart.items | json}}"],
] as const)
  test(`selected ${template} source output matches materialized data`, async () => {
    const snapshot = defaultFixture(),
      source = new FixtureRenderSource(snapshot);
    const files = () =>
      new MemoryThemeFileSystem({
        "layout/theme.liquid": "{{content_for_layout}}",
        [`templates/${template}.liquid`]: body,
      });
    const lazy = await renderTheme(files(), path, { source, staticPreview: true });
    const full = await renderTheme(files(), path, { snapshot });
    assert.equal(lazy.html, full.html);
    assert.equal(
      lazy.diagnostics.some((value) => value.code === "liquid-error"),
      false,
      JSON.stringify(lazy.diagnostics),
    );
  });

test("menu links, image metadata and native filters preserve source output", async () => {
  const snapshot: Snapshot = defaultFixture();
  snapshot.images = [
    {
      filename: "logo.png",
      file: "logo.png",
      width: 80,
      height: 40,
      alt: "Logo",
      focalPoint: null,
    },
  ];
  const body =
    "{% for link in linklists['main-menu'].links %}{{link.title}}:{{link.object.title}};{% endfor %}|{{all_products['sop-matrix-needle'].featured_image | image_url: width: 100 | image_tag}}|{{images['logo.png'] | image_url: width:40 | image_tag}}";
  const lazy = await renderTheme(theme(body), "/", {
    source: new FixtureRenderSource(snapshot),
    staticPreview: true,
  });
  const full = await renderTheme(theme(body), "/", { snapshot });
  assert.equal(lazy.html, full.html);
  assert.equal(
    lazy.diagnostics.some((value) => value.code === "liquid-error"),
    false,
    JSON.stringify(lazy.diagnostics),
  );
});

test("search form globals do not read the search domain before actual matching", async () => {
  const source = new FixtureRenderSource(fixture());
  const output = await renderTheme(
    theme("{{search.terms}}:{{search.performed}}:{{search.sort_options | size}}"),
    "/",
    { source, staticPreview: true },
  );
  assert.equal(output.html, ":false:3");
  assert.equal(source.reads.length, 0);
  assert.equal(source.lists.length, 0);
});

test("resolved global handles do not collide with dictionary implementation names", async () => {
  const snapshot = fixture(3);
  snapshot.products.forEach((product, index) => {
    product.handle = ["count", "lookup", "enumerate"][index] ?? "other";
  });
  const collection = snapshot.collections[0];
  assert.ok(collection);
  collection.products = snapshot.products.map((value) => value.handle);
  const body =
    "{{all_products.count.title}}|{{all_products.lookup.title}}|{{all_products.enumerate.title}}";
  const lazy = await renderTheme(theme(body), "/", {
    source: new FixtureRenderSource(snapshot),
    staticPreview: true,
  });
  assert.equal(lazy.html, (await renderTheme(theme(body), "/", { snapshot })).html);
});

test("render and include list bindings await bounded batch values", async () => {
  const snapshot = fixture(),
    source = new FixtureRenderSource(snapshot);
  const files = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.liquid":
      "{% assign cards = collections.featured.products | slice: 0, 4 %}{% render 'card' for cards as product %}{% include 'card' for cards as product %}",
    "snippets/card.liquid": "{{product.title}};",
  });
  const lazy = await renderTheme(files, "/", { source, staticPreview: true });
  assert.equal(lazy.html, (await renderTheme(files, "/", { snapshot })).html);
  assert.equal(source.reads.flat().filter((value) => value.kind === "product").length, 4);
  assert.equal(source.reads.filter((batch) => batch[0]?.kind === "product").length, 1);
});

test("reverse and slice preserve virtual bounds before a limited loop", async () => {
  const snapshot = fixture(),
    source = new FixtureRenderSource(snapshot);
  const body =
    "{% assign reversed = collections.featured.products | reverse %}{% for p in reversed limit: 4 %}{{p.title}};{% endfor %}";
  const output = await renderTheme(theme(body), "/", {
    source,
    staticPreview: true,
    backupPreview: { standardMoneyFormat: true },
  });
  assert.equal(
    output.html,
    (
      await renderTheme(theme(body), "/", {
        snapshot,
        backupPreview: { standardMoneyFormat: true },
      })
    ).html,
  );
  assert.equal(source.reads.flat().filter((value) => value.kind === "product").length, 4);
});

test("uncaptured lookup and membership stay unknown without fabricated records", async () => {
  const snapshot = fixture(2),
    collection = snapshot.collections[0];
  assert.ok(collection);
  delete collection.products;
  const source = new FixtureRenderSource(snapshot),
    resolve = source.resolve.bind(source);
  source.resolve = async (kind, key) =>
    kind === "page" ? { state: "not-captured" } : resolve(kind, key);
  const body =
    "{{pages.about.title}}|{{collections.featured.products_count}}|{{collections.featured.products | size}}";
  const output = await renderTheme(theme(body), "/", {
    source,
    staticPreview: true,
    backupPreview: { standardMoneyFormat: true },
  });
  assert.equal(
    output.diagnostics.some((value) => value.code === "liquid-error"),
    false,
  );
  assert.equal(
    source.reads.flat().filter((value) => value.kind === "product" || value.kind === "page").length,
    0,
  );
  assert.ok(
    output.diagnostics.some(
      (value) => value.message.includes("not-captured") || value.message.includes("not captured"),
    ),
  );
});

for (const [suffix, expectedReads] of [
  ["{% for p in joined limit:4 %}{{p.title}};{% endfor %}", 4],
  ["{% for p in joined offset:299 limit:4 %}{{p.title}};{% endfor %}", 4],
  ["{{joined | size}}", 0],
  ["{% assign sorted = joined | sort: 'title' %}{{sorted.last.title}}", 301],
] as const)
  test(`concat preserves structural bounds: ${suffix}`, async () => {
    const snapshot = fixture(),
      source = new FixtureRenderSource(snapshot);
    const body = `{% assign joined = collections.featured.products | concat: collections.featured.products %}${suffix}`;
    const options = { backupPreview: { standardMoneyFormat: true } };
    const output = await renderTheme(theme(body), "/", { ...options, source, staticPreview: true });
    assert.equal(output.html, (await renderTheme(theme(body), "/", { ...options, snapshot })).html);
    assert.equal(
      source.reads.flat().filter((value) => value.kind === "product").length,
      expectedReads,
    );
  });

for (const state of ["not-captured", "incomplete", "complete"] as const)
  test(`count coverage ${state} distinguishes unknown from known zero`, async () => {
    const source = new FixtureRenderSource(fixture(0)),
      header = source.header.bind(source);
    source.header = async () => {
      const value = await header();
      value.coverage.product = state;
      value.coverage.collection = state;
      value.counts.products = value.counts.collections = 0;
      return value;
    };
    const output = await renderTheme(
      theme("{{shop.products_count}}:{{shop.collections_count}}"),
      "/",
      { source, staticPreview: true },
    );
    assert.equal(output.html, state === "complete" ? "0:0" : ":");
    if (state !== "complete")
      assert.ok(
        output.diagnostics.some(
          (value) => value.code === "missing-resource" && value.message.includes(state),
        ),
      );
    assert.equal(source.reads.length, 0);
  });
