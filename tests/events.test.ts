import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { liquidObjects } from "../packages/data/src/objects.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const base = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/product.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "templates/collection.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "templates/search.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "templates/cart.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
};
test("product view payload distinguishes absent selection from a selected variant and preserves decimal amounts", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0],
    variant = product?.variants[0];
  assert.ok(product && variant);
  const theme = new MemoryThemeFileSystem({
    ...base,
    "sections/main.liquid":
      '<script type="application/json">{{product | standard_event_data: "view", context: "page"}}</script>',
  });
  const render = async (query: string) => {
    const result = await renderTheme(theme, `/products/${product.handle}${query}`, {
      snapshot,
      inspect: true,
    });
    assert.deepEqual(result.diagnostics, []);
    const data = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(result.html);
    assert.ok(data);
    return JSON.parse(data[1] ?? "");
  };
  assert.deepEqual(await render(""), {
    product: { id: 100001, title: product.title, handle: product.handle, selectedVariant: null },
    context: "page",
    selectedOptions: [],
  });
  const selectedOptions = variant.optionValues;
  assert.deepEqual(await render(`?variant=${variant.id}`), {
    product: {
      id: 100001,
      title: product.title,
      handle: product.handle,
      selectedVariant: {
        id: variant.id,
        title: "Red / Small / Cotton",
        availableForSale: true,
        price: { amount: "12.5", currencyCode: "USD" },
        selectedOptions,
      },
    },
    context: "page",
    selectedOptions,
  });
  variant.price = "10.00";
  assert.equal(
    (await render(`?variant=${variant.id}`)).product.selectedVariant.price.amount,
    "10.0",
  );
});

test("all-collection IDs remain null, collection context is ignored and search proxies retain product identity", async () => {
  const source =
    '<script type="application/json">{{collection | standard_event_data: "view", context: "ignored"}}</script>';
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...base, "sections/main.liquid": source }),
    "/collections/all",
  );
  assert.ok(result.html.includes('{"collection":{"id":null,"handle":"all","productsCount":40}}'));
  assert.deepEqual(result.diagnostics, []);
  const search = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "sections/main.liquid":
        '{% for product in search.results %}{{product.object_type}}|{{product|standard_event_data:"view",context:"search"}}|{{product.id}}{% endfor %}',
    }),
    "/search?q=Matrix%20Needle",
  );
  assert.ok(search.html.includes('product|{"product":{"id":100001'));
  assert.ok(search.html.includes('"context":"search"'));
  assert.deepEqual(search.diagnostics, []);
  const objects = liquidObjects(
    defaultFixture(),
    {
      pageType: "search",
      path: "/search?q=Matrix%20Needle",
      variant: null,
      q: "Matrix Needle",
      sortBy: null,
      resourceHandle: null,
      designMode: false,
    },
    { read() {}, unsupported() {} },
  );
  const searchObject = objects.search;
  assert.ok(
    searchObject &&
      typeof searchObject === "object" &&
      "results" in searchObject &&
      Array.isArray(searchObject.results),
  );
  assert.equal(
    Reflect.ownKeys(searchObject.results[0]).filter((key) => key === "object_type").length,
    1,
  );
});

test("cart views disclose the missing server session and invalid events, contexts or object types fail explicitly", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "sections/main.liquid":
        '{{cart | standard_event_data:"view", context:"dialog"}}|{{nil|standard_event_data:"view"}}|{{cart|standard_event_data:"buy"}}|{{cart|standard_event_data:"view",context:"invalid"}}',
    }),
    "/cart",
  );
  assert.ok(result.html.includes('{"context":"dialog","cart":null}'));
  assert.equal(result.diagnostics.filter((d) => d.code === "shopify-server-only").length, 1);
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 3);
});

test("event JSON safely contains markup while ordinary product comparisons do not trigger missing-property probes", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0];
  assert.ok(product);
  product.title = "</script> & Own";
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "sections/main.liquid":
        '{% if product == product %}Equal{% endif %}|{{product|standard_event_data:"view"}}',
    }),
    `/products/${product.handle}`,
    { snapshot },
  );
  assert.ok(
    result.html.includes(
      'Equal|{"product":{"id":100001,"title":"\\u003c\\/script\\u003e \\u0026 Own"',
    ),
  );
  assert.deepEqual(result.diagnostics, []);
});
