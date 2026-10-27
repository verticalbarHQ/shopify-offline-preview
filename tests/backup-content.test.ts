import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { validateSnapshotReferences } from "../packages/data/src/scenarios.js";
import { type Snapshot, snapshotSchema } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const hostDawn = {
  hideSampleText: true,
  imagePlaceholder:
    '<span aria-hidden="true" style="position:absolute;inset:0;display:grid;place-items:center;color:rgba(var(--color-foreground,0,0,0),.22);background:rgba(var(--color-foreground,0,0,0),.035)"><span data-sop-backup-image-placeholder aria-hidden="true" style="display:inline-block;width:24px;height:24px"></span></span>',
  pricePlaceholder:
    '<span data-sop-backup-price-placeholder aria-hidden="true" style="visibility:visible;position:absolute;inset-inline-start:0;top:4px;width:38%;height:12px;border-radius:3px;background:rgba(var(--color-foreground,0,0,0),.1)"></span>',
};

const price = `{% liquid
  if use_variant
    assign target = product.selected_or_first_available_variant
  else
    assign target = product
  endif
  assign price = target.price | default: 1999
  assign available = target.available | default: false
%}<div class="price">{{ price | money }}{% if available == false %}<b>{{ 'products.product.price.sold_out' | t }}</b>{% endif %}{% unless available %}<i>{{ 'products.product.price.unavailable' | t }}</i>{% endunless %}</div>`;
const card = `{% if card_product %}<article><h3>{{ card_product.title }}</h3>{% render 'price', product: card_product %}</article>{% else %}<article class="card"><div class="card__inner">{{ 'product-1' | placeholder_svg_tag }}</div><h3>{{ 'onboarding.product_title' | t }}</h3>{% render 'price' %}</article>{% endif %}`;
const listing = `<h2>Featured products</h2><ul>{% for item in collections.featured.products %}<li data-position="{{ forloop.index }}">{% render 'card-product', card_product: item %}</li>{% else %}{% for i in (1..4) %}<li>{% render 'card-product' %}</li>{% endfor %}{% endfor %}</ul>`;

function fixture(): Snapshot {
  const source = snapshotSchema.parse(defaultFixture());
  source.products = source.products.slice(0, 2);
  source.collections = [
    {
      handle: "featured",
      title: "Featured",
      descriptionHtml: "",
      image: null,
      products: source.products.map((product) => product.handle),
      sortOrder: "manual",
      templateSuffix: null,
    },
  ];
  source.cart.lines = [];
  source.shop.money_format = `\${{ amount }}`;
  source.shop.money_with_currency_format = `\${{ amount }} USD`;
  for (const product of source.products) {
    for (const variant of product.variants) {
      variant.price = "699.95";
      variant.compareAtPrice = null;
    }
  }
  return source;
}
function theme(body: string, overrides: Record<string, string> = {}) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{ content_for_layout }}",
    "templates/index.liquid": body,
    "templates/product.liquid": body,
    "snippets/price.liquid": price,
    "snippets/card-product.liquid": card,
    "locales/en.default.json": JSON.stringify({
      onboarding: { product_title: "Example product" },
      products: { product: { price: { sold_out: "Sold out", unavailable: "Unavailable" } } },
    }),
    ...overrides,
  });
}
function firstProduct(source: Snapshot) {
  const product = source.products[0];
  assert.ok(product);
  return product;
}
function firstCollection(source: Snapshot) {
  const collection = source.collections[0];
  assert.ok(collection);
  return collection;
}

test("backup preview standard currency uses captured amount, without changing snapshot formats", async () => {
  const source = fixture();
  delete source.shop.money_format;
  delete source.shop.money_with_currency_format;
  const before = structuredClone(source);
  const output = await renderTheme(
    theme("{{ product.price | money }}"),
    `/products/${firstProduct(source).handle}`,
    {
      snapshot: source,
      backupPreview: { dawn: hostDawn, standardMoneyFormat: true },
    },
  );
  assert.match(output.html, /USD 699\.95/);
  assert.deepEqual(source, before);
  const ordinary = await renderTheme(
    theme("{{ product.price | money }}"),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source },
  );
  assert.doesNotMatch(ordinary.html, /699\.95/);
});

test("unknown selected price is omitted while product title and stored image remain", async () => {
  const source = fixture();
  for (const [index, variant] of firstProduct(source).variants.entries()) {
    delete variant.available;
    variant.price = index === 0 ? "20.00" : "30.00";
  }
  const output = await renderTheme(
    theme(
      "<h1>{{ product.title }}</h1><img src=\"saved.png\">{% render 'price', product: product, use_variant: true %}",
    ),
    `/products/${firstProduct(source).handle}`,
    {
      snapshot: source,
      backupPreview: { dawn: hostDawn },
    },
  );
  assert.match(output.html, /<h1>.+<\/h1><img src="saved.png">/);
  assert.doesNotMatch(output.html, /19\.99|20\.00|30\.00|Sold out|Unavailable/);
});

test("known card minimum remains while unknown availability never becomes false through default", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme("{% render 'price', product: product %}"),
    `/products/${firstProduct(source).handle}`,
    {
      snapshot: source,
      backupPreview: { dawn: hostDawn },
    },
  );
  assert.match(output.html, /\$699\.95/);
  assert.doesNotMatch(output.html, /Sold out|Unavailable/);
});

test("known unavailable variant still shows its saved zero price and sold-out state", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) {
    variant.available = false;
    variant.price = "0.00";
  }
  const output = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}"),
    `/products/${firstProduct(source).handle}`,
    {
      snapshot: source,
      backupPreview: { dawn: hostDawn },
    },
  );
  assert.match(output.html, /\$0\.00/);
  assert.match(output.html, /Sold out/);
});

test("explicit missing collection member preserves its original slot without inventing a product", async () => {
  const source = fixture();
  const [first, second] = source.products;
  assert.ok(first && second);
  firstCollection(source).products = [first.handle, "missing", second.handle];
  firstCollection(source).missingProducts = ["missing"];
  const before = structuredClone(source);
  const output = await renderTheme(theme(listing), "/", {
    snapshot: source,
    backupPreview: { dawn: hostDawn },
  });
  assert.match(
    output.html,
    /data-position="1"[\s\S]*data-position="2"[\s\S]*data-sop-backup-image-placeholder[\s\S]*data-position="3"/,
  );
  assert.match(output.html, /data-sop-backup-price-placeholder/);
  assert.doesNotMatch(output.html, /Example product|19\.99/);
  assert.deepEqual(source, before);
  delete firstCollection(source).missingProducts;
  assert.throws(() => validateSnapshotReferences(source), /Missing collection member/);
});

test("unknown whole membership uses theme's four empty slots but known empty suppresses sample branch", async () => {
  const source = fixture();
  delete firstCollection(source).products;
  const unknown = await renderTheme(theme(listing), "/", {
    snapshot: source,
    backupPreview: { dawn: hostDawn },
  });
  assert.equal(unknown.html.match(/data-sop-backup-image-placeholder/g)?.length, 4);
  assert.equal(unknown.html.match(/data-sop-backup-price-placeholder/g)?.length, 4);
  assert.doesNotMatch(unknown.html, /Example product|19\.99|aria-busy|animation|<svg/);
  firstCollection(source).products = [];
  const empty = await renderTheme(theme(listing), "/", {
    snapshot: source,
    backupPreview: { dawn: hostDawn },
  });
  assert.match(empty.html, /Featured products/);
  assert.doesNotMatch(empty.html, /<li>|data-sop-backup/);
});

test("missing member declarations reject aliases, duplicates and contradictions", () => {
  const source = fixture();
  firstCollection(source).missingProducts = [firstProduct(source).handle];
  assert.throws(() => validateSnapshotReferences(source), /missing collection member/i);
  firstCollection(source).missingProducts = ["unlisted"];
  assert.throws(() => validateSnapshotReferences(source), /missing collection member/i);
});

test("equal captured variant prices can render without choosing an unknown variant", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const before = structuredClone(source);
  const output = await renderTheme(
    theme(
      "{% render 'price', product: product, use_variant: true %}<span>{{ product.selected_or_first_available_variant.title }}</span>",
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /\$699\.95/);
  assert.doesNotMatch(output.html, /Sold out|Unavailable/);
  assert.match(output.html, /<span><\/span>/);
  assert.deepEqual(source, before);
});

test("selection observes the first unknown or available position, including all-unavailable fallback", async () => {
  for (const [states, expected] of [
    [[undefined, true], null],
    [[false, true, undefined], "30.00"],
    [[true, undefined], "20.00"],
    [[false, false], "20.00"],
  ] as const) {
    const source = fixture();
    for (const [index, variant] of firstProduct(source).variants.entries()) {
      variant.price = `${20 + index * 10}.00`;
      if (index < states.length && states[index] === undefined) delete variant.available;
      else variant.available = states[index] ?? false;
    }
    const output = await renderTheme(
      theme(
        "<h1>{{ product.title }}</h1>{% render 'price', product: product, use_variant: true %}",
      ),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    if (expected === null) assert.doesNotMatch(output.html, /\$[\d,]|Sold out|Unavailable|19\.99/);
    else assert.ok(output.html.includes(`$${expected}`), JSON.stringify(states));
    assert.match(output.html, /<h1>.+<\/h1>/);
  }
});

test("failed format capture remains unknown while legacy standard formatting is explicit", async () => {
  const source = fixture();
  delete source.shop.money_format;
  delete source.shop.money_with_currency_format;
  const body =
    "<h1>{{ product.title }}</h1><p>Archive 1999</p>{% render 'price', product: product %}";
  const [failed, legacy] = await Promise.all([
    renderTheme(theme(body), `/products/${firstProduct(source).handle}`, {
      snapshot: source,
      backupPreview: { dawn: hostDawn, standardMoneyFormat: false },
    }),
    renderTheme(theme(body), `/products/${firstProduct(source).handle}`, {
      snapshot: source,
      backupPreview: { dawn: hostDawn, standardMoneyFormat: true },
    }),
  ]);
  assert.doesNotMatch(failed.html, /699\.95|19\.99/);
  assert.match(failed.html, /Archive 1999/);
  assert.match(legacy.html, /USD 699\.95/);
  assert.ok(failed.diagnostics.some((item) => item.message.includes("money_format")));
});

test("missing range translation retains the supplied known amount, without an invented label", async () => {
  const source = fixture();
  delete source.shop.locale;
  delete source.shop.money_format;
  const output = await renderTheme(
    theme(
      "{% assign amount = product.price | money %}{{ 'products.product.price.from_price_html' | t: price: amount }}",
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn, standardMoneyFormat: true } },
  );
  assert.match(output.html, /USD 699\.95/);
  assert.doesNotMatch(output.html, /From|translation missing/);
  assert.ok(output.diagnostics.some((item) => item.message.includes("shop.locale")));
});

test("older captured card media box gets a neutral marker without changing its ratio structure", async () => {
  const source = fixture();
  delete firstCollection(source).products;
  const files = theme(listing, {
    "snippets/card-product.liquid": `<article class="card"><div class="card__inner ratio" style="--ratio-percent:125%"><span class="existing"></span></div><div class="card__content"><h3>{{ 'onboarding.product_title' | t }}</h3>{% render 'price' %}</div></article>`,
  });
  const output = await renderTheme(files, "/", {
    snapshot: source,
    backupPreview: { dawn: hostDawn },
  });
  assert.equal(output.html.match(/data-sop-backup-image-placeholder/g)?.length, 4);
  assert.equal(output.html.match(/data-sop-backup-price-placeholder/g)?.length, 4);
  assert.equal(output.html.match(/--ratio-percent:125%/g)?.length, 4);
  assert.equal(output.html.match(/class="existing"/g)?.length, 4);
  assert.doesNotMatch(output.html, /<svg|Example product|19\.99/);
});

test("price-named snippet containing known product content preserves that content", async () => {
  const source = fixture();
  for (const [index, variant] of firstProduct(source).variants.entries()) {
    delete variant.available;
    variant.price = `${20 + index * 10}.00`;
  }
  const files = theme("{% render 'price', product: product, use_variant: true %}", {
    "snippets/price.liquid": `<h2>{{ product.title }}</h2><p>1999 edition</p>${price}`,
  });
  const output = await renderTheme(files, `/products/${firstProduct(source).handle}`, {
    snapshot: source,
    backupPreview: { dawn: hostDawn },
  });
  assert.match(output.html, /<h2>.+<\/h2>/);
  assert.match(output.html, /1999 edition/);
  assert.doesNotMatch(output.html, /19\.99|Sold out|Unavailable/);
});

for (const [name, body] of [
  [
    "capture money",
    "{% capture a %}{{ product.selected_or_first_available_variant.price | money }}{% endcapture %}{{ a | default: 1999 | money }}",
  ],
  [
    "capture blank",
    "{% capture a %}{{ product.selected_or_first_available_variant.price }}{% endcapture %}{% if a == blank %}SOLD OUT{% endif %}",
  ],
  [
    "selection loop",
    "{% assign a = product.variants | where: 'available', true %}{% for v in a %}{{ v.price }}{% else %}Sold out{% endfor %}",
  ],
  [
    "unknown loop",
    "{% for v in product.selected_or_first_available_variant %}{{ v.price }}{% else %}Sold out{% endfor %}",
  ],
] as const) {
  test(`unknown commercial provenance survives ${name}`, async () => {
    const source = fixture();
    for (const variant of firstProduct(source).variants) delete variant.available;
    delete source.shop.money_format;
    const output = await renderTheme(
      theme(`Before${body}After`),
      `/products/${firstProduct(source).handle}`,
      {
        snapshot: source,
        backupPreview: { dawn: hostDawn, standardMoneyFormat: true },
      },
    );
    assert.equal(output.html, "BeforeAfter");
    assert.equal(output.diagnostics.filter((item) => item.code === "liquid-error").length, 0);
  });
}

for (const filter of [
  "sort: 'title'",
  "compact",
  "reverse",
  "where: 'available', true",
  "map: 'title'",
  "uniq",
] as const) {
  test(`missing member list refuses uncertain ${filter} without a sample else`, async () => {
    const source = fixture();
    const [first, second] = source.products;
    assert.ok(first && second);
    first.title = "Z";
    second.title = "A";
    firstCollection(source).products = [first.handle, "missing", second.handle];
    firstCollection(source).missingProducts = ["missing"];
    const output = await renderTheme(
      theme(
        `Before{% assign list = collections.featured.products | ${filter} %}{% for item in list %}[{{ forloop.index }}:{{ item.title | default: 'MISSING' }}]{% else %}FAKE PRODUCT{% endfor %}After`,
      ),
      "/",
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, "BeforeAfter");
    assert.ok(
      output.diagnostics.some((item) => item.message.includes("missing collection members")),
    );
  });
}

for (const filter of ["sort: 'title'", "reverse", "where: 'available', true", "compact"] as const) {
  test(`captured empty collection stays empty after ${filter}`, async () => {
    const source = fixture();
    firstCollection(source).products = [];
    const output = await renderTheme(
      theme(
        `Before{% assign list = collections.featured.products | ${filter} %}{% for item in list %}CARD{% else %}FAKE PRODUCT{% endfor %}After`,
      ),
      "/",
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, "BeforeAfter");
  });
}

for (const [name, content, expected] of [
  [
    "literal media",
    '<img src="saved.png" alt="Saved product">',
    '<img src="saved.png" alt="Saved product">',
  ],
  [
    "nested media",
    "{% render 'photo', product: product %}",
    '<img src="saved.png" alt="Saved product">',
  ],
  ["static body", "<p>Archive 1999</p>", "<p>Archive 1999</p>"],
] as const) {
  test(`a price-named snippet preserves unrelated ${name}`, async () => {
    const source = fixture();
    for (const [index, variant] of firstProduct(source).variants.entries()) {
      delete variant.available;
      variant.price = `${20 + index * 10}.00`;
    }
    const output = await renderTheme(
      theme("{% render 'price', product: product, use_variant: true %}", {
        "snippets/price.liquid": `${content}{{ product.selected_or_first_available_variant.price | money }}`,
        "snippets/photo.liquid": '<img src="saved.png" alt="Saved product">',
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, expected);
  });
}

test("common price omits only the proven unknown unit-price region", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": `{% if use_variant %}{% assign target = product.selected_or_first_available_variant %}{% else %}{% assign target = product %}{% endif %}<div class="price">{{ target.price | money }}<small class="unit-price caption{% if product.selected_or_first_available_variant.unit_price_measurement == nil %} hidden{% endif %}">{{ product.selected_or_first_available_variant.unit_price | money }}/{{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small></div>`,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /\$699\.95/);
  assert.doesNotMatch(output.html, /unit-price|<small/);
});

test("partial captures preserve known markup on direct output and echo, including aliases", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme(
      `{% capture body %}<img src="saved.png"><p>Archive 1999</p>{{ product.selected_or_first_available_variant.price | money }}{% endcapture %}{{ body }}{% assign alias = body %}{% echo alias %}{% if body == blank %}Sold out{% endif %}{{ body | default: 1999 | money }}`,
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(
    output.html,
    '<img src="saved.png"><p>Archive 1999</p><img src="saved.png"><p>Archive 1999</p>',
  );
});

test("capture retains unknown provenance across a nested rendered snippet", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme(
      `Before{% capture body %}{% render 'amount', product: product %}{% endcapture %}{{ body | default: 1999 | money }}After`,
      {
        "snippets/amount.liquid": "{{ product.selected_or_first_available_variant.price | money }}",
      },
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, "BeforeAfter");
});

test("ordinary capture, known false selection and opted-out behavior remain unchanged", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) variant.available = false;
  const body = `{% capture price %}{{ product.selected_or_first_available_variant.price }}{% endcapture %}{{ price | money }}{% capture label %}Known text{% endcapture %}{{ label }}{% assign available = product.variants | where: 'available', true %}{% for item in available %}CARD{% else %}Sold out{% endfor %}`;
  for (const backupPreview of [undefined, {}]) {
    const output = await renderTheme(theme(body), `/products/${firstProduct(source).handle}`, {
      snapshot: source,
      ...(backupPreview ? { backupPreview } : {}),
    });
    assert.equal(output.html, "$699.95Known textSold out");
  }
});

test("direct limited missing slots and known list transformations retain proven order", async () => {
  const source = fixture();
  const [first, second] = source.products;
  assert.ok(first && second);
  first.title = "Z";
  second.title = "A";
  firstCollection(source).products = [first.handle, "missing", second.handle];
  firstCollection(source).missingProducts = ["missing"];
  const output = await renderTheme(
    theme(
      `{% for item in collections.featured.products limit: 2 %}[{{ forloop.index }}:{{ item.title | default: 'MISSING' }}]{% endfor %}`,
    ),
    "/",
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, "[1:Z][2:MISSING]");
  firstCollection(source).products = [first.handle, second.handle];
  delete firstCollection(source).missingProducts;
  const sorted = await renderTheme(
    theme(
      `{% assign list = collections.featured.products | sort: 'title' %}{% for item in list %}{{ item.title }}{% endfor %}`,
    ),
    "/",
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(sorted.html, "AZ");
});

test("refused collection URL reorder does not run the sample-empty branch", async () => {
  const source = fixture();
  firstCollection(source).products = [firstProduct(source).handle, "missing"];
  firstCollection(source).missingProducts = ["missing"];
  const output = await renderTheme(
    theme("{% for item in collections.featured.products %}CARD{% else %}FAKE PRODUCT{% endfor %}", {
      "templates/collection.liquid":
        "Before{% for item in collection.products %}CARD{% else %}FAKE PRODUCT{% endfor %}After",
    }),
    "/collections/featured?sort_by=title-ascending",
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, "BeforeAfter");
  assert.ok(output.diagnostics.some((item) => item.message.includes("missing members")));
});

test("known unit price and measurement remain visible in a proven price region", async () => {
  const source = fixture();
  const variant = firstProduct(source).variants[0];
  assert.ok(variant);
  variant.available = true;
  variant.unitPrice = "1.25";
  variant.unitPriceMeasurement = {
    measured_type: "weight",
    quantity_unit: "g",
    quantity_value: 1000,
    reference_unit: "kg",
    reference_value: 1,
  };
  const priceSource = `<div class="price">{{ product.selected_or_first_available_variant.price | money }}<small class="unit-price">{{ product.selected_or_first_available_variant.unit_price | money }}/{{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small></div>`;
  const output = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": priceSource,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /<small class="unit-price">\$1\.25\/kg<\/small>/);
  delete variant.unitPrice;
  const unknownAmount = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": priceSource,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(unknownAmount.html, /\$699\.95/);
  assert.doesNotMatch(unknownAmount.html, /unit-price|<small/);
});

test("nested section uncertainty does not erase a JSON template's known page content", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme("unused", {
      "templates/product.json": JSON.stringify({
        sections: { main: { type: "main-product" } },
        order: ["main"],
      }),
      "sections/main-product.liquid": `<h1>{{ product.title }}</h1><img src="saved.png">{% render 'price', product: product, use_variant: true %}{% schema %}{"name":"Product","settings":[]}{% endschema %}`,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /<h1>.+<\/h1><img src="saved.png">/);
  assert.match(output.html, /\$699\.95/);
});

for (const expression of [
  "{% capture body %}{{ product.selected_or_first_available_variant.price | money }}{% endcapture %}{% render 'show' with body as v %}",
  "{% render 'show' with product.selected_or_first_available_variant.price as v %}",
] as const) {
  test(`render with preserves unknown commercial binding: ${expression}`, async () => {
    const source = fixture();
    for (const variant of firstProduct(source).variants) delete variant.available;
    delete source.shop.money_format;
    const output = await renderTheme(
      theme(`Before${expression}After`, {
        "snippets/show.liquid": "{{ v | default: 1999 | money }}",
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn, standardMoneyFormat: true } },
    );
    assert.equal(output.html, "BeforeAfter");
  });
}

test("render with preserves known partial capture markup but not semantic defaults", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme(
      `{% capture body %}<img src="saved.png"><p>Archive 1999</p>{{ product.selected_or_first_available_variant.price | money }}{% endcapture %}{% render 'show' with body as v %}`,
      {
        "snippets/show.liquid": "{{ v }}|{{ v | default: 1999 | money }}",
      },
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, '<img src="saved.png"><p>Archive 1999</p>|');
});

for (const expression of [
  "{% capture a %}{{ product.price | money }}{% endcapture %}{{ a | default: 1999 }}",
  "{% assign a = product.price | money %}{{ a | default: 1999 }}",
  "{{ product.price | money | default: 1999 }}",
] as const) {
  test(`missing captured money format preserves unknown result: ${expression}`, async () => {
    const source = fixture();
    delete source.shop.money_format;
    delete source.shop.money_with_currency_format;
    const output = await renderTheme(
      theme(`Before${expression}After`),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn, standardMoneyFormat: false } },
    );
    assert.equal(output.html, "BeforeAfter");
  });
}

for (const [content, expected] of [
  ["<span>{{ shop.name }}</span>", "<span>Offline Example Shop</span>"],
  ["{% assign label = shop.name %}<span>{{ label }}</span>", "<span>Offline Example Shop</span>"],
  ["<span>{{ settings.note }}</span>", "<span>Saved note</span>"],
  ["{% echo shop.name %}", "Offline Example Shop"],
] as const) {
  test(`price-only shortcut preserves unrelated dynamic output: ${content}`, async () => {
    const source = fixture();
    for (const [index, variant] of firstProduct(source).variants.entries()) {
      delete variant.available;
      variant.price = `${20 + index * 10}.00`;
    }
    const output = await renderTheme(
      theme("{% render 'price', product: product, use_variant: true %}", {
        "snippets/price.liquid": `${content}{{ product.selected_or_first_available_variant.price | money }}`,
        "config/settings_schema.json": JSON.stringify([
          { name: "Example", settings: [{ type: "text", id: "note", default: "Saved note" }] },
        ]),
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, expected);
  });
}

test("mixed price snippet omits only its independently proven unknown unit region", async () => {
  const source = fixture();
  for (const [index, variant] of firstProduct(source).variants.entries()) {
    delete variant.available;
    variant.price = `${20 + index * 10}.00`;
  }
  const unit = `<small class="unit-price">{{ product.selected_or_first_available_variant.unit_price | money }}/{{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small>`;
  const output = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": `<p>Archive 1999</p>${unit}{{ product.selected_or_first_available_variant.price | money }}`,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, "<p>Archive 1999</p>");
  const mixedUnit = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": `${unit.replace('<small class="unit-price">', '<small class="unit-price"><span>{{ shop.name }}</span>')}{{ product.selected_or_first_available_variant.price | money }}`,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(mixedUnit.html, /<span>Offline Example Shop<\/span>/);
});

for (const field of ["price", "price_min"] as const) {
  test(`unused use_variant flag does not erase known product ${field}`, async () => {
    const source = fixture();
    for (const [index, variant] of firstProduct(source).variants.entries()) {
      delete variant.available;
      variant.price = index === 0 ? "20.00" : "30.00";
    }
    const output = await renderTheme(
      theme("{% render 'price', product: product, use_variant: true %}", {
        "snippets/price.liquid": `{{ product.${field} | money }}`,
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, "$20.00");
  });
}

test("known product minimum survives alongside an unknown selected compare-at output", async () => {
  const source = fixture();
  for (const [index, variant] of firstProduct(source).variants.entries()) {
    delete variant.available;
    variant.price = index === 0 ? "20.00" : "30.00";
  }
  const output = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": `<div class="price">{{ product.price_min | money }}{{ product.selected_or_first_available_variant.compare_at_price | money }}</div>`,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, '<div class="price">$20.00</div>');
});

test("render bindings preserve ordinary known scalars and known captures", async () => {
  const source = fixture();
  const body = `{% capture note %}Saved note{% endcapture %}{% render 'show' with note as v %}{% render 'show' with false as v %}`;
  for (const backupPreview of [undefined, {}]) {
    const output = await renderTheme(theme(body, { "snippets/show.liquid": "[{{ v }}]" }), "/", {
      snapshot: source,
      ...(backupPreview ? { backupPreview } : {}),
    });
    assert.equal(output.html, "[Saved note][false]");
  }
});

for (const [name, other] of [
  ["literal sibling", '<small class="unit-price"><span>{{ shop.name }}</span></small>'],
  ["nested rendered sibling", "{% render 'other' %}"],
] as const) {
  test(`an unrendered unit proof cannot delete a different ${name}`, async () => {
    const source = fixture();
    for (const [index, variant] of firstProduct(source).variants.entries()) {
      delete variant.available;
      variant.price = index === 0 ? "20.00" : "30.00";
    }
    const output = await renderTheme(
      theme("{% render 'price', product: product, use_variant: true %}", {
        "snippets/price.liquid": `{% if false %}<small class="unit-price">{{ product.selected_or_first_available_variant.unit_price | money }}/{{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small>{% endif %}${other}{{ product.selected_or_first_available_variant.price | money }}`,
        "snippets/other.liquid": '<small class="unit-price"><span>{{ shop.name }}</span></small>',
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(
      output.html,
      '<small class="unit-price"><span>Offline Example Shop</span></small>',
    );
  });
}

test("unit omission targets its rendered source node while preserving a same-class sibling", async () => {
  const source = fixture();
  for (const [index, variant] of firstProduct(source).variants.entries()) {
    delete variant.available;
    variant.price = index === 0 ? "20.00" : "30.00";
  }
  const output = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": `<small class="unit-price">{{ product.selected_or_first_available_variant.unit_price | money }}/{{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small><small class="unit-price"><span>{{ shop.name }}</span></small>{{ product.selected_or_first_available_variant.price | money }}`,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, '<small class="unit-price"><span>Offline Example Shop</span></small>');
});

test("a later product binding change cannot erase an already rendered known unit price", async () => {
  const source = fixture();
  const [first, second] = source.products;
  assert.ok(first && second && first.variants[0]);
  first.variants[0].available = true;
  first.variants[0].unitPrice = "1.25";
  first.variants[0].unitPriceMeasurement = {
    measured_type: "weight",
    quantity_unit: "g",
    quantity_value: 1000,
    reference_unit: "kg",
    reference_value: 1,
  };
  for (const variant of second.variants) delete variant.available;
  const output = await renderTheme(
    theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": `<small class="unit-price">{{ product.selected_or_first_available_variant.unit_price | money }}/{{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small>{% assign product = all_products['${second.handle}'] %}{{ product.selected_or_first_available_variant.price | money }}`,
    }),
    `/products/${first.handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /<small class="unit-price">\$1\.25\/kg<\/small>/);
  assert.doesNotMatch(output.html, /sop-backup-unit/);
});

test("unit transport does not alter source error attribution or leak into results", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const files = theme("{% render 'price', product: product, use_variant: true %}", {
    "snippets/price.liquid": `<p>Archive 1999</p>\n<small class="unit-price">{{ product.selected_or_first_available_variant.unit_price | money }}/{{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small>\n{{ 1 | divided_by: 0 }}\n`,
  });
  const [ordinary, backup] = await Promise.all([
    renderTheme(files, `/products/${firstProduct(source).handle}`, {
      snapshot: source,
      liquidErrors: "omit",
    }),
    renderTheme(files, `/products/${firstProduct(source).handle}`, {
      snapshot: source,
      liquidErrors: "omit",
      backupPreview: { dawn: hostDawn },
    }),
  ]);
  const errors = (output: typeof backup) =>
    output.diagnostics
      .filter((item) => item.code === "liquid-error")
      .map(({ file, line, message }) => ({ file, line, message }));
  assert.deepEqual(errors(backup), errors(ordinary));
  assert.deepEqual(errors(backup), [
    { file: "snippets/price.liquid", line: 3, message: "divided by 0" },
  ]);
  assert.match(backup.html, /<p>Archive 1999<\/p>/);
  assert.doesNotMatch(backup.html, /sop-backup-unit|class="unit-price"/);
});

test("known unit markup and whitespace stay identical, including an escaped capture", async () => {
  const source = fixture();
  const variant = firstProduct(source).variants[0];
  assert.ok(variant);
  variant.available = true;
  variant.unitPrice = "1.25";
  variant.unitPriceMeasurement = {
    measured_type: "weight",
    quantity_unit: "g",
    quantity_value: 1000,
    reference_unit: "kg",
    reference_value: 1,
  };
  const unit = `<small class="unit-price">{{- product.selected_or_first_available_variant.unit_price | money -}} / {{ product.selected_or_first_available_variant.unit_price_measurement.reference_unit }}</small>`;
  for (const content of [
    ` \n${unit}\n `,
    `{% capture unit %}${unit}{% endcapture %}{{ unit | escape }}`,
  ]) {
    const files = theme("{% render 'price', product: product, use_variant: true %}", {
      "snippets/price.liquid": content,
    });
    const [ordinary, backup] = await Promise.all([
      renderTheme(files, `/products/${firstProduct(source).handle}`, { snapshot: source }),
      renderTheme(files, `/products/${firstProduct(source).handle}`, {
        snapshot: source,
        backupPreview: { dawn: hostDawn },
      }),
    ]);
    assert.equal(backup.html, ordinary.html);
    assert.deepEqual(backup.tree, ordinary.tree);
    assert.doesNotMatch(backup.html, /sop-backup-unit/);
  }
});

test("empty product price keeps the theme line box and wrappers with only decorative blank content", async () => {
  const source = fixture();
  const output = await renderTheme(
    theme("{% render 'price' %}", {
      "snippets/price.liquid": `<div class="price" style="font-size:var(--price-size)"><div class="price__container"><div class="price__regular"><span class="visually-hidden">{{ 'products.product.price.sold_out' | t }}</span><span class="price-item" tabindex="0" style="line-height:var(--price-line-height)">{{ product.price | default: 1999 | money }}</span></div></div></div>`,
    }),
    "/",
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /class="price"/);
  assert.match(output.html, /class="price__container"/);
  assert.match(output.html, /class="price__regular"/);
  assert.match(output.html, /class="price-item"[^>]*>&nbsp;<\/span>/);
  assert.match(output.html, /font-size:var\(--price-size\)/);
  assert.match(output.html, /line-height:var\(--price-line-height\)/);
  assert.match(output.html, /visibility:hidden/);
  assert.match(output.html, /data-sop-backup-price-placeholder/);
  assert.doesNotMatch(output.html, /Sold out|19\.99|1999|tabindex|height:0/);
});

test("bare empty price output retains an inherited line box without an invented amount", async () => {
  const source = fixture();
  const output = await renderTheme(
    theme("{% render 'price' %}", {
      "snippets/price.liquid": "{{ product.price | default: 1999 | money }}",
    }),
    "/",
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /&nbsp;/);
  assert.match(output.html, /data-sop-backup-price-placeholder/);
  assert.doesNotMatch(output.html, /height:0|19\.99|1999/);
});

for (const [name, missingBody, helper] of [
  ["direct render", "{% render 'price' %}", ""],
  ["render then include", "{% render 'empty-helper' %}", "{% include 'price' %}"],
  ["include then render", "{% include 'empty-helper' %}", "{% render 'price' %}"],
] as const) {
  for (const membership of ["missing member", "unknown list"] as const) {
    test(`empty card ${name} cannot inherit page price from ${membership}`, async () => {
      const source = fixture();
      const [first, second] = source.products;
      assert.ok(first && second);
      for (const variant of second.variants) variant.price = "39.99";
      firstCollection(source).products = [first.handle, "missing", second.handle];
      firstCollection(source).missingProducts = ["missing"];
      if (membership === "unknown list") {
        delete firstCollection(source).products;
        delete firstCollection(source).missingProducts;
      }
      const files = theme(
        `<header>{{ product.price | money }}</header>${listing}<footer>{{ product.price | money }}</footer>`,
        {
          "snippets/card-product.liquid": `{% if card_product %}<article data-kind="known">{{ card_product.title }}{% render 'price', product: card_product %}</article>{% else %}<article data-kind="missing"><div class="card__inner"></div>${missingBody}</article>{% endif %}`,
          "snippets/empty-helper.liquid": helper,
        },
      );
      const output = await renderTheme(files, `/products/${first.handle}`, {
        snapshot: source,
        backupPreview: { dawn: hostDawn },
      });
      const emptyCards = [
        ...output.html.matchAll(/<article data-kind="missing">([\s\S]*?)<\/article>/g),
      ];
      assert.equal(emptyCards.length, membership === "missing member" ? 1 : 4);
      for (const [, body] of emptyCards) {
        assert.match(body ?? "", /data-sop-backup-price-placeholder/);
        assert.doesNotMatch(body ?? "", /699\.95|39\.99|1999|19\.99/);
      }
      assert.match(output.html, /<header>\$699\.95<\/header>/);
      assert.match(output.html, /<footer>\$699\.95<\/footer>/);
      if (membership === "missing member") {
        const knownCards = [
          ...output.html.matchAll(/<article data-kind="known">([\s\S]*?)<\/article>/g),
        ];
        assert.equal(knownCards.length, 2);
        assert.match(knownCards[0]?.[1] ?? "", /\$699\.95/);
        assert.match(knownCards[1]?.[1] ?? "", /\$39\.99/);
      }
    });
  }
}

for (const kind of ["render", "include"] as const) {
  test(`empty card ${kind} keeps explicit product overrides and restores surrounding page context`, async () => {
    const source = fixture();
    const [first, second] = source.products;
    assert.ok(first && second);
    for (const variant of second.variants) variant.price = "39.99";
    const output = await renderTheme(
      theme(
        `{% ${kind} 'card-product', card_product: nil %}<footer>{{ product.price | money }}</footer>`,
        {
          "snippets/card-product.liquid": `<div class="card__inner"></div>{% ${kind} 'empty-helper', product: all_products['${second.handle}'] %}`,
          "snippets/empty-helper.liquid": "{% render 'price' %}",
        },
      ),
      `/products/${first.handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.match(output.html, /\$39\.99/);
    assert.match(output.html, /<footer>\$699\.95<\/footer>/);
    assert.doesNotMatch(output.html, /data-sop-backup-price-placeholder/);
  });
}

test("non-opted-in empty card retains ordinary ambient product scope", async () => {
  const source = fixture();
  const output = await renderTheme(
    theme("{% render 'card-product' %}", {
      "snippets/card-product.liquid": "{% render 'price' %}",
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source },
  );
  assert.match(output.html, /\$699\.95/);
  assert.doesNotMatch(output.html, /data-sop-backup-price-placeholder/);
});

test("explicit nil inside a missing card stays empty instead of reviving sample or page prices", async () => {
  const source = fixture();
  const output = await renderTheme(
    theme("{% render 'card-product' %}", {
      "snippets/card-product.liquid": "{% render 'empty-helper', product: nil %}",
      "snippets/empty-helper.liquid": "{% render 'price' %}",
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /data-sop-backup-price-placeholder/);
  assert.doesNotMatch(output.html, /699\.95|1999|19\.99/);
});

for (const kind of ["render", "include"] as const) {
  test(`missing card ${kind} allows an explicit local product assignment`, async () => {
    const source = fixture();
    const [first, second] = source.products;
    assert.ok(first && second);
    for (const variant of second.variants) variant.price = "39.99";
    const output = await renderTheme(
      theme(`{% ${kind} 'card-product' %}<footer>{{ product.price | money }}</footer>`, {
        "snippets/card-product.liquid": `{% assign product = all_products['${second.handle}'] %}<span>{{ product.title }}</span><div>{{ product.price | money }}</div>{% render 'price', product: product %}`,
      }),
      `/products/${first.handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.match(output.html, /<span>SOP Product 02<\/span><div>\$39\.99<\/div>/);
    assert.equal(output.html.match(/\$39\.99/g)?.length, 2);
    assert.match(output.html, /<footer>\$699\.95<\/footer>/);
    assert.doesNotMatch(output.html, /data-sop-backup-price-placeholder/);
  });

  test(`missing card ${kind} preserves a known capture assigned to product`, async () => {
    const source = fixture();
    const output = await renderTheme(
      theme(`{% ${kind} 'card-product' %}<footer>{{ product.price | money }}</footer>`, {
        "snippets/card-product.liquid":
          "{% capture product %}<strong>Saved note</strong>{% endcapture %}{{ product }}",
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, "<strong>Saved note</strong><footer>$699.95</footer>");
  });
}

for (const captured of [false, true]) {
  test(`missing card includes retain shared ${captured ? "capture" : "assignment"} writes`, async () => {
    const source = fixture();
    const second = source.products[1];
    assert.ok(second);
    const output = await renderTheme(
      theme("{% render 'card-product' %}<footer>{{ product.price | money }}</footer>", {
        "snippets/card-product.liquid": `{% include 'choose' %}${captured ? "{{ product }}" : "{{ product.title }}"}`,
        "snippets/choose.liquid": captured
          ? "{% capture product %}<strong>Saved note</strong>{% endcapture %}"
          : `{% assign product = all_products['${second.handle}'] %}`,
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(
      output.html,
      `${captured ? "<strong>Saved note</strong>" : "SOP Product 02"}<footer>$699.95</footer>`,
    );
  });
}

test("missing include card restores the caller's prior local product binding", async () => {
  const source = fixture();
  const second = source.products[1];
  assert.ok(second);
  for (const variant of second.variants) variant.price = "39.99";
  const output = await renderTheme(
    theme(
      `{% assign product = all_products['${second.handle}'] %}{% include 'card-product' %}<footer>{{ product.price | money }}</footer>`,
      {
        "snippets/card-product.liquid": "{% render 'price' %}",
      },
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /data-sop-backup-price-placeholder/);
  assert.equal(output.html.match(/\$39\.99/g)?.length, 1);
  assert.match(output.html, /<footer>\$39\.99<\/footer>/);
});

for (const [name, body, expected] of [
  [
    "selected alias overwritten by known product",
    "{% assign target = product.selected_or_first_available_variant %}{% assign target = product %}{{ target.price | money }}",
    "$20.00",
  ],
  [
    "known alias overwritten by unknown selection",
    "{% assign target = product %}{% assign target = product.selected_or_first_available_variant %}{{ target.price | money }}",
    "",
  ],
  [
    "known overwrite carried through an alias chain",
    "{% assign a = product.selected_or_first_available_variant %}{% assign a = product %}{% assign b = a %}{% assign target = b %}{{ target.price | money }}",
    "$20.00",
  ],
  [
    "earlier unknown alias retains its assigned value",
    "{% assign a = product.selected_or_first_available_variant %}{% assign target = a %}{% assign a = product %}{{ target.price | money }}",
    "",
  ],
  [
    "unexecuted selected assignment does not erase known minimum",
    "{% assign target = product %}{% if false %}{% assign target = product.selected_or_first_available_variant %}{% endif %}{{ target.price | money }}",
    "$20.00",
  ],
  [
    "executed known branch replaces unknown selection",
    "{% assign target = product.selected_or_first_available_variant %}{% if true %}{% assign target = product %}{% endif %}{{ target.price | money }}",
    "$20.00",
  ],
  [
    "unknown availability branch does not erase established minimum",
    "{% assign target = product %}{% if product.available %}{% assign target = product.selected_or_first_available_variant %}{% endif %}{{ target.price | money }}",
    "$20.00",
  ],
  [
    "known general body remains after price alias overwrite",
    "{% assign target = product.selected_or_first_available_variant %}{% assign target = shop.name %}<span>{{ target }}</span>",
    "<span>Offline Example Shop</span>",
  ],
] as const) {
  test(`price rendering respects runtime assignments: ${name}`, async () => {
    const source = fixture();
    for (const [index, variant] of firstProduct(source).variants.entries()) {
      delete variant.available;
      variant.price = `${20 + index * 10}.00`;
    }
    const output = await renderTheme(
      theme("{% render 'price', product: product, use_variant: true %}", {
        "snippets/price.liquid": body,
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, expected);
    assert.equal(output.diagnostics.filter((item) => item.code === "liquid-error").length, 0);
  });
}

const savedGallery = `{% if selected.featured_media != nil %}<img data-media="{{ selected.featured_media.id }}" src="{{ selected.featured_media | image_url: width: 64 }}">{% endif %}{% for media in product.media %}{% unless media.id == selected.featured_media.id %}<img data-media="{{ media.id }}" src="{{ media | image_url: width: 64 }}">{% endunless %}{% endfor %}`;
for (const selectedKnown of [false, true]) {
  for (const binding of ["direct", "alias", "render", "include"] as const) {
    test(`saved gallery survives ${selectedKnown ? "known" : "unknown"} selection via ${binding}`, async () => {
      const source = fixture();
      if (!selectedKnown)
        for (const variant of firstProduct(source).variants) delete variant.available;
      const body =
        binding === "direct"
          ? savedGallery.replaceAll("selected.", "product.selected_or_first_available_variant.")
          : binding === "alias"
            ? `{% assign selected = product.selected_or_first_available_variant %}${savedGallery}`
            : `{% ${binding} 'gallery', selected: product.selected_or_first_available_variant %}`;
      const output = await renderTheme(
        theme(body, { "snippets/gallery.liquid": savedGallery }),
        `/products/${firstProduct(source).handle}`,
        { snapshot: source, backupPreview: { dawn: hostDawn } },
      );
      assert.equal(output.html.match(/<img /g)?.length, 2);
      assert.equal(output.html.match(/pattern-01\.png/g)?.length, 1);
      assert.equal(output.html.match(/pattern-02\.png/g)?.length, 1);
      assert.equal(output.diagnostics.filter((item) => item.code === "liquid-error").length, 0);
    });
  }
}

for (const body of [
  "{{ product.selected_or_first_available_variant | default: 1999 | money }}",
  "{% capture selected %}{{ product.selected_or_first_available_variant }}{% endcapture %}{{ selected | default: 1999 | money }}",
  "{% capture selected %}{% echo product.selected_or_first_available_variant %}{% endcapture %}{{ selected | default: 1999 | money }}",
  "{% assign selected = product.selected_or_first_available_variant %}{{ selected.id | default: 'invented' }}{% if selected == nil %}Sold out{% endif %}",
  "{% render 'identity' with product.selected_or_first_available_variant as selected %}",
  "{% for selected in product.selected_or_first_available_variant %}invented{% else %}Sold out{% endfor %}",
] as const) {
  test(`media reference handling retains unknown selected identity: ${body}`, async () => {
    const source = fixture();
    for (const variant of firstProduct(source).variants) delete variant.available;
    const output = await renderTheme(
      theme(body, { "snippets/identity.liquid": "{{ selected | default: 1999 | money }}" }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.equal(output.html, "");
  });
}

test("a commercial unknown is not reclassified as an absent selected-media reference", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme(
      "{% assign selected = product.selected_or_first_available_variant.price %}{% unless selected.featured_media.id %}invented{% endunless %}",
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, "");
});

test("selected-media reference handling does not admit a commercial property suffix", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme(
      "{{ product.selected_or_first_available_variant.featured_media.price | default: 1999 | money }}{% assign selected = product.selected_or_first_available_variant %}{% capture amount %}{{ selected.featured_media.price }}{% endcapture %}{{ amount | default: 1999 | money }}",
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(output.html, "");
});

test("dynamic selected-media lookups restore commercial guards and match the browser bundle", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const files = {
    "layout/theme.liquid": "{{ content_for_layout }}",
    "templates/product.liquid": `{% assign selector = 'selected_or_first_available_variant' %}{% assign reference = 'featured_media' %}{% for media in product.media %}{% unless media.id == product[selector][reference].id %}<img src="{{ media | image_url: width: 64 }}">{% endunless %}{% endfor %}{{ product[selector].price | default: 1999 | money }}{% if product[selector] == nil %}Sold out{% endif %}`,
  };
  const options = { snapshot: source, backupPreview: { dawn: hostDawn }, inspect: true };
  const path = `/products/${firstProduct(source).handle}`;
  const output = await renderTheme(new MemoryThemeFileSystem(files), path, options);
  assert.equal(output.html.match(/<img /g)?.length, 2);
  assert.doesNotMatch(output.html, /19\.99|Sold out/);
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(files), path, options),
    output,
  );
});

test("known emitted price reveals only its dedicated no-JS wrapper", async () => {
  const source = fixture();
  const output = await renderTheme(
    theme(
      '<div class="no-js-hidden" id="known-price">{% render \'price\', product: product, use_variant: true %}</div><div class="no-js-hidden" id="other">Saved body</div>',
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /class="" id="known-price"/);
  assert.match(output.html, /\$699\.95/);
  assert.match(output.html, /class="no-js-hidden" id="other">Saved body/);
});

test("computed or captured unused money does not reveal an unknown-price wrapper", async () => {
  const source = fixture();
  for (const [i, variant] of firstProduct(source).variants.entries()) {
    delete variant.available;
    variant.price = i ? "30.00" : "20.00";
  }
  for (const computation of [
    "{% assign unused = product.price | money %}",
    "{% capture unused %}{{ product.price | money }}{% endcapture %}",
  ]) {
    const output = await renderTheme(
      theme(
        "<div class=\"no-js-hidden\">{% render 'price', product: product, use_variant: true %}</div>",
        {
          "snippets/price.liquid": `${computation}<div class="price">{{ product.selected_or_first_available_variant.price | money }}</div>`,
        },
      ),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    assert.match(output.html, /class="no-js-hidden"/);
    assert.doesNotMatch(output.html, /\$20|\$30/);
  }
});

test("price visibility proof does not reveal mixed or unexecuted content", async () => {
  const source = fixture();
  for (const body of [
    "<div class=\"no-js-hidden\">Saved body{% render 'price', product: product %}</div>",
    "<div class=\"no-js-hidden\"><span>Saved body</span>{% render 'price', product: product %}</div>",
    "{% if false %}{% render 'price', product: product %}{% endif %}<div class=\"no-js-hidden\">Saved body</div>",
  ]) {
    const output = await renderTheme(theme(body), `/products/${firstProduct(source).handle}`, {
      snapshot: source,
      backupPreview: { dawn: hostDawn },
    });
    assert.match(output.html, /class="no-js-hidden"/);
    assert.match(output.html, /Saved body/);
  }
});

const variantPicker = `<select name="id">{% for variant in product.variants %}<option value="{{ variant.id }}" {% if variant == product.selected_or_first_available_variant %}selected="selected"{% endif %}>{{ variant.title }} - {{ variant.price | money }}</option>{% endfor %}</select>`;
for (const known of [false, true]) {
  test(`native variant control preserves ${known ? "known selection" : "unknown selection without a first-option fallback"}`, async () => {
    const source = fixture();
    if (!known) for (const variant of firstProduct(source).variants) delete variant.available;
    const output = await renderTheme(
      theme("{% render 'product-variant-picker', product: product %}", {
        "snippets/product-variant-picker.liquid": variantPicker,
      }),
      `/products/${firstProduct(source).handle}`,
      { snapshot: source, backupPreview: { dawn: hostDawn } },
    );
    for (const variant of firstProduct(source).variants)
      assert.ok(output.html.includes(variant.id));
    assert.equal(
      output.html.match(/<option\b/g)?.length,
      firstProduct(source).variants.length + (known ? 0 : 1),
    );
    if (known) assert.doesNotMatch(output.html, /data-sop-backup-unselected|<select[^>]*disabled/);
    else {
      assert.match(output.html, /<select[^>]*disabled/);
      assert.match(
        output.html,
        /<option value="" selected disabled hidden aria-hidden="true" data-sop-backup-unselected><\/option>/,
      );
    }
  });
}

test("unrendered variant-control proof cannot change an unrelated select", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme("{% render 'product-variant-picker', product: product %}", {
      "snippets/product-variant-picker.liquid": `{% if false %}${variantPicker}{% endif %}<select name="id"><option value="topic">Saved topic</option></select>`,
    }),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.equal(
    output.html,
    '<select name="id"><option value="topic">Saved topic</option></select>',
  );
});

test("captured price snippets retain their body without transporting internal proof markers", async () => {
  const source = fixture();
  const output = await renderTheme(
    theme(
      "{% capture body %}{% render 'price', product: product %}{% endcapture %}<pre>{{ body | escape }}</pre>",
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source, backupPreview: { dawn: hostDawn } },
  );
  assert.match(output.html, /699\.95/);
  assert.doesNotMatch(output.html, /:price:start|:price:end|&lt;!--/);
});

test("static price and variant control policy leaves generic rendering unchanged", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const output = await renderTheme(
    theme(
      `<div class="no-js-hidden">{% render 'price', product: product %}</div>{% render 'product-variant-picker', product: product %}`,
      {
        "snippets/product-variant-picker.liquid": variantPicker,
      },
    ),
    `/products/${firstProduct(source).handle}`,
    { snapshot: source },
  );
  assert.match(output.html, /class="no-js-hidden"/);
  assert.doesNotMatch(output.html, /data-sop-backup-unselected|<select[^>]*disabled/);
});

test("generic backup guards preserve unknown facts without enabling Dawn presentation", async () => {
  const source = fixture();
  for (const variant of firstProduct(source).variants) delete variant.available;
  const files = theme(
    `<h1>{{ product.title }}</h1><i>{{ product.selected_or_first_available_variant.price | default: 1999 | money }}</i>{{ 'onboarding.product_title' | t }}<div class="no-js-hidden">{% render 'price', product: product %}</div>`,
  );
  const options = { snapshot: source, backupPreview: {} };
  const output = await renderTheme(files, `/products/${firstProduct(source).handle}`, options);
  assert.match(output.html, /<i><\/i>/);
  assert.match(output.html, /Example product/);
  assert.match(output.html, /class="no-js-hidden"/);
  assert.doesNotMatch(output.html, /data-sop-backup|24px|width:38%/);
  assert.ok(output.diagnostics.some((item) => item.code === "missing-resource"));
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  assert.deepEqual(
    await browser.renderTheme(files, `/products/${firstProduct(source).handle}`, options),
    output,
  );
});

test("hosts independently choose Dawn decoration and sample text policy", async () => {
  const source = fixture();
  const files = theme("{% render 'card-product' %}");
  const dawn = {
    imagePlaceholder: '<span data-host-image aria-hidden="true"></span>',
    pricePlaceholder: '<span data-host-price aria-hidden="true"></span>',
  };
  const visible = await renderTheme(files, "/", { snapshot: source, backupPreview: { dawn } });
  assert.equal(visible.html.match(/data-host-image/g)?.length, 1);
  assert.equal(visible.html.match(/data-host-price/g)?.length, 1);
  assert.match(visible.html, /Example product/);
  assert.doesNotMatch(visible.html, /data-sop-backup|24px|width:38%/);
  const hidden = await renderTheme(files, "/", {
    snapshot: source,
    backupPreview: { dawn: { ...dawn, hideSampleText: true } },
  });
  assert.doesNotMatch(hidden.html, /Example product/);
  assert.match(hidden.html, /data-host-image/);
  const undecorated = await renderTheme(files, "/", {
    snapshot: source,
    backupPreview: { dawn: {} },
  });
  assert.doesNotMatch(undecorated.html, /data-host-|data-sop-backup/);
  assert.match(undecorated.html, /Example product/);
});

for (const [name, body] of [
  [
    "assigned range size",
    "{% assign amount = (0..product.selected_or_first_available_variant.price) | size %}{{ amount | money }}",
  ],
  [
    "assigned range iteration",
    "{% assign numbers = (0..product.selected_or_first_available_variant.price) %}{% for n in numbers %}invented{% else %}invented empty{% endfor %}{{ numbers | size | default: 1999 | money }}",
  ],
  [
    "direct range iteration",
    "{% for n in (0..product.selected_or_first_available_variant.price) %}invented{% else %}invented empty{% endfor %}",
  ],
  [
    "table range iteration",
    "{% tablerow n in (0..product.selected_or_first_available_variant.price) %}invented{% endtablerow %}",
  ],
  [
    "render range iteration",
    "{% render 'range-item' for (0..product.selected_or_first_available_variant.price) as item %}",
  ],
  [
    "include range iteration",
    "{% include 'range-item' for (0..product.selected_or_first_available_variant.price) as item %}",
  ],
]) {
  test(`unknown endpoints survive ${name} in common and Dawn backup modes`, async () => {
    const source = fixture();
    for (const variant of firstProduct(source).variants) delete variant.available;
    const files = theme(`before|${body}|after`, { "snippets/range-item.liquid": "invented" });
    for (const backupPreview of [{}, { dawn: hostDawn }]) {
      const output = await renderTheme(files, `/products/${firstProduct(source).handle}`, {
        snapshot: source,
        backupPreview,
      });
      assert.equal(output.html, "before||after");
      assert.ok(output.diagnostics.some((d) => d.code === "missing-resource"));
      const browser: typeof import("../packages/check/src/browser.js") = await import(
        new URL("../dist/browser.js", import.meta.url).href
      );
      assert.deepEqual(
        await browser.renderTheme(files, `/products/${firstProduct(source).handle}`, {
          snapshot: source,
          backupPreview,
        }),
        output,
      );
    }
  });
}
