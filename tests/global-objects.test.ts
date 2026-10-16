import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { isBlockedEndpoint } from "../packages/dev/src/endpoints.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const template = '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}';
function theme(source: string) {
  return new MemoryThemeFileSystem({
    "templates/index.json": template,
    "templates/product.json": template,
    "templates/product.alt.json": template,
    "templates/collection.json": template,
    "sections/main.liquid": source,
  });
}
const routeKeys = [
  "root_url",
  "account_url",
  "account_login_url",
  "account_logout_url",
  "account_recover_url",
  "account_register_url",
  "account_addresses_url",
  "collections_url",
  "all_products_collection_url",
  "search_url",
  "predictive_search_url",
  "cart_url",
  "cart_add_url",
  "cart_change_url",
  "cart_clear_url",
  "cart_update_url",
  "product_recommendations_url",
];

test("routes expose Shopify's storefront paths and the cart endpoints stay blocked offline", async () => {
  const result = await renderTheme(
    theme(
      `${routeKeys.map((key) => `{{ routes.${key} }}`).join(",")}|{{ routes.account_profile_url }}`,
    ),
    "/",
    { snapshot: defaultFixture() },
  );
  const html = result.html.replace(/<\/?div[^>]*>/g, "");
  const [paths = "", missing] = html.split("|");
  assert.deepEqual(paths.split(","), [
    "/",
    "/account",
    "/account/login",
    "/account/logout",
    "/account/recover",
    "/account/register",
    "/account/addresses",
    "/collections",
    "/collections/all",
    "/search",
    "/search/suggest",
    "/cart",
    "/cart/add",
    "/cart/change",
    "/cart/clear",
    "/cart/update",
    "/recommendations/products",
  ]);
  assert.equal(missing, "");
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    ["Object property routes.account_profile_url is not available offline."],
  );
  // Dawn posts to the route itself; Horizon appends `.js`. Both reach the blocked-endpoint contract.
  for (const path of [
    "/cart/add",
    "/cart/change",
    "/cart/update",
    "/cart/clear",
    "/search/suggest",
    "/recommendations/products",
  ]) {
    assert.ok(isBlockedEndpoint(new URL(path, "https://preview.invalid")), path);
    if (path.startsWith("/cart/"))
      assert.ok(isBlockedEndpoint(new URL(`${path}.js`, "https://preview.invalid")), path);
  }
});

test("template outputs and compares as its name with suffix", async () => {
  const source =
    "{{ template }}|{{ template.name }}|{{ template.suffix | json }}|{{ template.directory | json }}|{% if template == 'product' %}eq{% endif %}|{% if template contains 'product' %}has{% endif %}|{{ template | split: '.' | last }}";
  let result = await renderTheme(theme(source), "/products/sop-matrix-needle", {
    snapshot: defaultFixture(),
  });
  assert.ok(result.html.includes("product|product|null|null|eq|has|product"), result.html);
  result = await renderTheme(
    theme(`${source}{{ template.layout }}`),
    "/products/sop-matrix-needle?view=alt",
    {
      snapshot: defaultFixture(),
    },
  );
  assert.ok(result.html.includes('product.alt|product|"alt"|null||has|alt'), result.html);
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    ["Object property template.layout is not available offline."],
  );
});

test("canonical_url drops view parameters except the page and page_image uses the resource image", async () => {
  const source =
    "{{ canonical_url }}|{% if page_image %}{{ page_image.src }}{% else %}none{% endif %}";
  let result = await renderTheme(
    theme(source),
    "/products/sop-matrix-needle?variant=sop-main-2&view=",
    { snapshot: defaultFixture() },
  );
  assert.ok(
    result.html.includes("https://example.test/products/sop-matrix-needle|/sop/images/"),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
  result = await renderTheme(
    theme(source),
    "/collections/sop-catalog?sort_by=price-ascending&page=2",
    {
      snapshot: defaultFixture(),
    },
  );
  assert.ok(
    result.html.includes("https://example.test/collections/sop-catalog?page=2|/sop/images/"),
  );
  // The fixture declares no social sharing image, so the home page has none.
  result = await renderTheme(theme(source), "/", { snapshot: defaultFixture() });
  assert.ok(result.html.includes("https://example.test/|none"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
