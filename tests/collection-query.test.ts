import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { parseSnapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function snapshot() {
  const value = defaultFixture();
  const target = value.products[4];
  assert.ok(target);
  target.vendor = "Unique Vendor";
  value.filters = [
    {
      id: "filter.p.vendor",
      label: "Vendor",
      type: "list",
      values: [
        { label: "Unique Vendor", value: "Unique Vendor" },
        { label: "Example Studio", value: "Example Studio" },
      ],
    },
    {
      id: "filter.v.option.color",
      label: "Color",
      type: "list",
      values: [{ label: "Blue", value: "Blue" }],
    },
    { id: "filter.v.price", label: "Price", type: "price_range", values: [] },
  ];
  return value;
}
const theme = new MemoryThemeFileSystem({
  "templates/collection.json":
    '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
  "sections/main.liquid":
    "{{ collection.products_count }}/{{ collection.all_products_count }}/{{ collections.all.products_count }};{% for f in collection.filters %}{{ f.param_name }}:{{ f.operator }}:{{ f.active_values.size }}:{{ f.url_to_remove }}{% for v in f.values %}[{{ v.label }}={{ v.count }}:{{ v.active }}:{{ v.url_to_add }}:{{ v.url_to_remove }}]{% endfor %};{% endfor %}{% paginate collection.products by 3 %}{% for p in collection.products %}{{ p.handle }}@{{ p.price }},{% endfor %}{% endpaginate %}",
});
async function render(query: string) {
  const result = await renderTheme(theme, `/collections/sop-catalog${query}`, {
    snapshot: snapshot(),
  });
  return { html: result.html.replace(/<\/?div[^>]*>/g, ""), diagnostics: result.diagnostics };
}

test("collection sort_by orders the viewed collection; ties keep snapshot order", async () => {
  let result = await render("?sort_by=price-descending");
  assert.ok(result.html.endsWith("sop-product-40@4900,sop-product-39@4800,sop-product-38@4700,"));
  result = await render("?sort_by=price-ascending");
  assert.ok(
    result.html.endsWith("sop-product-02@1100,sop-product-03@1200,sop-matrix-needle@1250,"),
  );
  result = await render("?sort_by=title-descending");
  assert.ok(result.html.endsWith("sop-product-40@4900,sop-product-39@4800,sop-product-38@4700,"));
  assert.deepEqual(result.diagnostics, []);
  result = await render("?sort_by=best-selling");
  assert.ok(
    result.html.endsWith("sop-matrix-needle@1250,sop-product-02@1100,sop-product-03@1200,"),
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    [
      "Collection sort best-selling cannot be decided from the snapshot; the snapshot order is used.",
    ],
  );
});

test("list and price filters select products, count facets and build Shopify filter URLs", async () => {
  let result = await render("");
  assert.ok(
    result.html.startsWith(
      "40/40/40;filter.p.vendor:OR:0:/collections/sop-catalog" +
        "[Unique Vendor=1:false:/collections/sop-catalog?filter.p.vendor=Unique+Vendor:/collections/sop-catalog]" +
        "[Example Studio=39:false:/collections/sop-catalog?filter.p.vendor=Example+Studio:/collections/sop-catalog];" +
        "filter.v.option.color:OR:0:/collections/sop-catalog[Blue=1:false:",
    ),
    result.html,
  );
  result = await render("?filter.p.vendor=Unique+Vendor&page=2&sort_by=title-ascending");
  assert.ok(
    result.html.startsWith(
      "1/40/40;filter.p.vendor:OR:1:/collections/sop-catalog?sort_by=title-ascending" +
        "[Unique Vendor=1:true:/collections/sop-catalog?filter.p.vendor=Unique+Vendor&sort_by=title-ascending:/collections/sop-catalog?sort_by=title-ascending]" +
        "[Example Studio=39:false:/collections/sop-catalog?filter.p.vendor=Unique+Vendor&sort_by=title-ascending&filter.p.vendor=Example+Studio:/collections/sop-catalog?filter.p.vendor=Unique+Vendor&sort_by=title-ascending];" +
        "filter.v.option.color:OR:0:/collections/sop-catalog?filter.p.vendor=Unique+Vendor&sort_by=title-ascending[Blue=0:",
    ),
    result.html,
  );
  // Page 2 of a one-product result is empty.
  assert.ok(result.html.endsWith(";"), result.html);
  result = await render("?filter.v.option.color=Blue");
  assert.ok(result.html.startsWith("1/40/40;"), result.html);
  assert.ok(result.html.endsWith("sop-matrix-needle@1250,"), result.html);
  result = await render("?filter.v.price.gte=45&filter.v.price.lte=48");
  assert.ok(result.html.startsWith("4/40/40;"), result.html);
  assert.ok(result.html.endsWith("sop-product-36@4500,sop-product-37@4600,sop-product-38@4700,"));
  assert.deepEqual(result.diagnostics, []);
});

test("filters the snapshot cannot decide are reported instead of silently ignored", async () => {
  const value = snapshot();
  value.filters.push({
    id: "filter.v.m.custom.fabric",
    label: "Fabric",
    type: "list",
    operator: "OR",
    values: [{ label: "Wool", value: "Wool" }],
  });
  const result = await renderTheme(
    theme,
    "/collections/sop-catalog?filter.v.m.custom.fabric=Wool",
    {
      snapshot: value,
    },
  );
  assert.ok(result.html.includes("40/40/40;"));
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    [
      "Storefront filter filter.v.m.custom.fabric cannot be decided from the snapshot; results are not filtered by it.",
      "Object property filter_value.count is not available offline.",
    ],
  );
});

test("availability filters accept textual true and false values", async () => {
  const value = snapshot();
  value.filters = [
    {
      id: "filter.v.availability",
      label: "Availability",
      type: "boolean",
      values: [
        { label: "In stock", value: "true" },
        { label: "Out of stock", value: "false" },
      ],
    },
  ];
  const count = async (query: string) =>
    (await renderTheme(theme, `/collections/sop-catalog${query}`, { snapshot: value })).html
      .replace(/<\/?div[^>]*>/g, "")
      .split(";")[0];
  assert.equal(await count("?filter.v.availability=true"), "40/40/40");
  assert.equal(await count("?filter.v.availability=1"), "40/40/40");
  assert.equal(await count("?filter.v.availability=false"), "1/40/40");
});

test("tag and metafield filter operators come from the snapshot, never a guess", async () => {
  const tags = (operator?: "AND" | "OR") => {
    const value = snapshot();
    value.filters = [
      {
        id: "filter.p.tag",
        label: "Tag",
        type: "list",
        ...(operator ? { operator } : {}),
        values: [
          { label: "red", value: "red" },
          { label: "sop-fixture", value: "sop-fixture" },
        ],
      },
    ];
    return value;
  };
  const view = async (operator: "AND" | "OR" | undefined, query: string) => {
    const result = await renderTheme(theme, `/collections/sop-catalog${query}`, {
      snapshot: tags(operator),
    });
    const html = result.html.replace(/<\/?div[^>]*>/g, "");
    return { head: html.slice(0, html.indexOf(";", html.indexOf(";") + 1) + 1), result };
  };
  const both = "?filter.p.tag=red&filter.p.tag=sop-fixture";
  let { head, result } = await view("AND", both);
  assert.ok(head.startsWith("20/40/40;filter.p.tag:AND:2:"), head);
  assert.ok(head.includes("[red=20:true:") && head.includes("[sop-fixture=20:true:"), head);
  assert.deepEqual(result.diagnostics, []);
  ({ head, result } = await view("OR", both));
  assert.ok(head.startsWith("40/40/40;filter.p.tag:OR:2:"), head);
  assert.deepEqual(result.diagnostics, []);
  ({ head, result } = await view(undefined, both));
  assert.ok(head.startsWith("40/40/40;filter.p.tag::2:"), head);
  assert.deepEqual(
    result.diagnostics.map((d) => [d.code, d.message]),
    [
      [
        "missing-resource",
        "The operator of storefront filter filter.p.tag is absent from the snapshot; selected values are combined with OR.",
      ],
      ["missing-resource", "Object property filter.operator is absent from the snapshot."],
    ],
  );
  const vendor = snapshot();
  vendor.filters = [
    { id: "filter.p.vendor", label: "Vendor", type: "list", operator: "AND", values: [] },
  ];
  assert.throws(() => parseSnapshot(JSON.stringify(vendor)));
});
