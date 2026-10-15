import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("price range maximum uses all variant prices in the current collection in Liquid hundredths", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.money_format = "${{ amount }}";
  snapshot.products[1]!.variants[0]!.price = "2500.00";
  const product = snapshot.products[0]!;
  product.variants[0]!.price = "999.25";
  const collection = snapshot.collections[0]!;
  collection.products = [product.handle];
  snapshot.filters = [{ id: "filter.v.price", label: "Price", type: "price_range", values: [] }];
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/collection.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{% for filter in collection.filters %}[{{filter.range_max}}:{{filter.range_max | money}}:{{filter.min_value.param_name}}={{filter.min_value.value}}:{{filter.max_value.param_name}}={{filter.max_value.value}}:{{filter.url_to_remove}}:{{cart.currency.symbol}}]{% endfor %}`,
  });
  let result = await renderTheme(
    theme,
    `/collections/${collection.handle}?filter.v.price.gte=10.25&filter.v.price.lte=500&sort_by=price-ascending&page=2`,
    { snapshot },
  );
  assert.ok(
    result.html.includes(
      `[99925:$999.25:filter.v.price.gte=1025:filter.v.price.lte=50000:/collections/${collection.handle}?sort_by=price-ascending:$]`,
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
  collection.products = [];
  result = await renderTheme(theme, `/collections/${collection.handle}`, { snapshot });
  assert.ok(result.html.includes(`[0:$0.00:filter.v.price.gte=:filter.v.price.lte=:`), result.html);
  snapshot.shop.currency = "JPY";
  result = await renderTheme(theme, `/collections/${collection.handle}`, { snapshot });
  assert.ok(result.html.includes(":¥]"));
});
