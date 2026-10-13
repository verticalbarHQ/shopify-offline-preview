import assert from "node:assert/strict";
import { test } from "node:test";
import { Liquid } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { liquidObjects } from "../packages/data/src/objects.js";
import { renderTheme } from "../packages/render/src/index.js";
import { resolveRoute } from "../packages/render/src/routes.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const route = {
  pageType: "index",
  path: "/",
  variant: null,
  q: "",
  sortBy: null,
  resourceHandle: null,
  designMode: false,
};
test("automatic catalog is globally accessible, alphabetic and excluded from persisted collection lists", async () => {
  const snapshot = defaultFixture();
  snapshot.products.reverse();
  const missing: string[] = [];
  const globals = liquidObjects(snapshot, route, {
    read() {},
    unsupported(type, key) {
      missing.push(`${type}.${key}`);
    },
  });
  const output = await new Liquid().parseAndRender(
    "{{collections.all.title}}|{{collections.all.products_count}}|{{collections.size}}|{% for c in collections %}{{c.handle}};{% endfor %}|{{collections.all.products.first.title}}|{{all_products['sop-matrix-needle'].collections.size}}",
    globals,
  );
  assert.equal(output, "Products|40|1|sop-catalog;|SOP Matrix Needle|1");
  assert.deepEqual(missing, []);
});

test("a supplied all collection controls membership, order, template and SEO metadata", async () => {
  const snapshot = defaultFixture(),
    original = snapshot.collections[0];
  assert.ok(original);
  snapshot.collections.push({
    ...original,
    id: "200002",
    handle: "all",
    title: "Own Catalog",
    products: [snapshot.products[3]?.handle ?? "", snapshot.products[0]?.handle ?? ""],
    templateSuffix: "own",
    seo: { title: "Own catalog SEO", description: "Own catalog description" },
  });
  assert.equal(resolveRoute(snapshot, "/collections/all").resource?.kind, "collection");
  assert.equal(
    resolveRoute(snapshot, "/collections/all").template,
    "templates/collection.own.json",
  );
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/collection.own.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "sections/main.liquid":
        "{{page_title}}|{{collection.id}}|{{collection.products_count}}|{{collection.products.first.handle}}",
    }),
    "/collections/all",
    { snapshot },
  );
  assert.ok(result.html.includes(`Own catalog SEO|200002|2|${snapshot.products[3]?.handle}`));
  assert.deepEqual(result.diagnostics, []);
});

test("global automatic catalog can be paginated inside isolated snippets without a collection route", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "sections/main.liquid": "{% render 'own' %}",
      "snippets/own.liquid":
        "{% assign collection=collections.all %}{% paginate collection.products by 4 %}{{paginate.items}}/{{collection.products.size}}/{% for product in collection.products %}{{product.title}};{% endfor %}|{{collection|standard_event_data:'view'}}{% endpaginate %}",
    }),
    "/",
  );
  assert.ok(
    result.html.includes("40/4/SOP Matrix Needle;SOP Product 02;SOP Product 03;SOP Product 04;"),
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes('{"collection":{"id":null,"handle":"all","productsCount":40}}'));
});
