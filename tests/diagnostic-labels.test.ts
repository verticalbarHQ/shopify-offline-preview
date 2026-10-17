import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import type { Snapshot } from "../packages/data/src/schema.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(template: string, source: string, extra: Record<string, string> = {}) {
  return new MemoryThemeFileSystem({
    [`templates/${template}.json`]:
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
    ...extra,
  });
}
const product = "/products/sop-matrix-needle";
function messages(result: { diagnostics: { code: string; message: string }[] }, code: string) {
  return result.diagnostics.filter((d) => d.code === code).map((d) => d.message);
}

test("request.locale is the shop's language entry, with direction, and diagnoses absent language data", async () => {
  const source =
    "[{{ request.locale.iso_code }}|{{ request.locale.name }}|{{ request.locale.primary }}|{{ request.locale.root_url }}|{{ request.locale.direction }}]";
  const listed = await renderTheme(theme("index", source), "/");
  assert.ok(listed.html.includes("[en|English|true|/|ltr]"), listed.html);
  assert.deepEqual(listed.diagnostics, []);

  const snapshot = defaultFixture();
  delete snapshot.localization;
  snapshot.shop.locale = "ar";
  const unlisted = await renderTheme(theme("index", source), "/", { snapshot });
  assert.ok(unlisted.html.includes("[ar||||rtl]"), unlisted.html);
  assert.deepEqual(messages(unlisted, "missing-resource"), [
    "Object property shop_locale.name is absent from the snapshot.",
    "Object property shop_locale.primary is absent from the snapshot.",
    "Object property shop_locale.root_url is absent from the snapshot.",
  ]);
  assert.deepEqual(messages(unlisted, "not-implemented"), []);
});

test("cart.currency names come from the localized shop currency and other reads are diagnosed", async () => {
  const result = await renderTheme(
    theme(
      "cart",
      "[{{ cart.currency.iso_code }}|{{ cart.currency.symbol }}|{{ cart.currency.name }}|{{ cart.currency.flag }}]",
    ),
    "/cart",
  );
  assert.ok(result.html.includes("[USD|$|United States Dollar|]"), result.html);
  assert.deepEqual(messages(result, "not-implemented"), [
    "Object property currency.flag is not available offline.",
  ]);
});

test("section, block, form and paginate objects diagnose unknown properties and keep their documented ones", async () => {
  const files = {
    "templates/collection.json": JSON.stringify({
      layout: false,
      sections: { main: { type: "main", blocks: { b: { type: "text" } }, block_order: ["b"] } },
      order: ["main"],
    }),
    "sections/main.liquid": `{% for block in section.blocks %}[{{ block.type }}|{{ block.shopify_attributes }}|{{ block.extra }}]{% endfor %}[{{ section.location }}|{{ section.shopify_attributes }}|{{ section.extra }}]{% form 'customer' %}[{{ form.id }}|{{ form.email }}|{{ form.posted_successfully? }}|{{ form.extra }}]{% endform %}{% paginate collection.products by 5 %}[{{ paginate.next.url }}|{{ paginate.next.is_link }}|{{ paginate.parts.first.title }}|{{ paginate.extra }}|{{ paginate.next.extra }}]{% endpaginate %}{% schema %}{"blocks":[{"type":"text","name":"Text"}]}{% endschema %}`,
  };
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/collections/sop-catalog");
  assert.ok(result.html.includes("[text||]"), result.html);
  assert.ok(result.html.includes("[template||]"), result.html);
  assert.ok(result.html.includes("[||false|]"), result.html);
  assert.ok(result.html.includes("[/collections/sop-catalog?page=2|true|1||]"), result.html);
  assert.deepEqual(messages(result, "not-implemented").sort(), [
    "Object property block.extra is not available offline.",
    "Object property form.extra is not available offline.",
    "Object property paginate.extra is not available offline.",
    "Object property part.extra is not available offline.",
    "Object property section.extra is not available offline.",
  ]);
});

test("omitted source fields are missing data while undocumented properties stay not implemented", async () => {
  const snapshot = defaultFixture();
  const main = snapshot.products[0];
  assert.ok(main?.images[0]);
  delete main.id;
  delete main.images[0].id;
  delete main.images[0].focalPoint;
  const result = await renderTheme(
    theme(
      "product",
      "[{{ product.id }}|{{ product.featured_image.id }}|{{ product.featured_image.presentation }}|{{ product.featured_image.product_id }}|{{ product.not_a_property }}]",
    ),
    product,
    { snapshot },
  );
  assert.deepEqual(messages(result, "missing-resource").sort(), [
    "Object property image.id is absent from the snapshot.",
    "Object property image.presentation is absent from the snapshot.",
    "Object property image.product_id is absent from the snapshot.",
    "Object property product.id is absent from the snapshot.",
  ]);
  assert.deepEqual(messages(result, "not-implemented"), [
    "Object property product.not_a_property is not available offline.",
  ]);
});

test("focal points: null means unset (centered, no image_tag style), values print as percentages", async () => {
  const snapshot = defaultFixture();
  // image_tag finds image metadata by local file, so every use of the file gets the point.
  for (const entry of snapshot.products.flatMap((p) => p.images))
    if (entry.file === "pattern-02.png") entry.focalPoint = { x: "0.25", y: "0.75" };
  const result = await renderTheme(
    theme(
      "product",
      "{% for image in product.images %}[{{ image.presentation.focal_point }}|{{ image.presentation.focal_point.x }}|{{ image | image_url: width: 64 | image_tag }}]{% endfor %}",
    ),
    product,
    { snapshot },
  );
  const [unset, set] = result.html.match(/\[[^\]]*\]/g) ?? [];
  assert.ok(unset?.startsWith("[50% 50%|50|<img") && !unset.includes("object-position"), unset);
  assert.ok(set?.startsWith("[25% 75%|25|<img") && set.includes("object-position:25% 75%"), set);
  assert.deepEqual(result.diagnostics, []);
});

test("option value IDs and swatches come from the snapshot; null swatches are nil", async () => {
  const snapshot = defaultFixture();
  const color = snapshot.products[0]?.options[0];
  assert.ok(color?.swatches);
  color.swatches[1] = {
    color: "#0000ff",
    image: { file: "pattern-02.png", alt: "Blue", width: 64, height: 64, focalPoint: null },
  };
  const result = await renderTheme(
    theme(
      "product",
      "{% for value in product.options_with_values.first.values %}[{{ value.id }}|{{ value.swatch.color.rgb }}|{{ value.swatch.image.alt }}|{{ value.swatch == nil }}]{% endfor %}",
    ),
    product,
    { snapshot },
  );
  assert.ok(result.html.includes("[900001|||true][900002|0 0 255|Blue|false]"), result.html);
  assert.deepEqual(result.diagnostics, []);
  const option = snapshot.products[0]?.options[0];
  assert.ok(option);
  option.valueIds = ["1"];
  await assert.rejects(
    renderTheme(theme("product", ""), product, { snapshot }),
    /one entry per value/,
  );
});

test("page_image falls back to the social sharing image; null is unset and omission is missing data", async () => {
  const source = "[{{ page_image.src }}]";
  const unset = await renderTheme(theme("index", source), "/");
  assert.ok(unset.html.includes("[]"));
  assert.deepEqual(unset.diagnostics, []);

  const snapshot: Snapshot = defaultFixture();
  snapshot.shop.socialSharingImage = {
    file: "pattern-03.png",
    alt: "Share",
    width: 64,
    height: 64,
    focalPoint: null,
  };
  const supplied = await renderTheme(theme("index", source), "/", { snapshot });
  assert.ok(supplied.html.includes("[/sop/images/pattern-03.png]"), supplied.html);

  delete snapshot.shop.socialSharingImage;
  const omitted = await renderTheme(theme("index", source), "/", { snapshot });
  assert.deepEqual(messages(omitted, "missing-resource"), [
    "The shop's social sharing image is absent from the snapshot; page_image is nil.",
  ]);
});

test("documented globals without offline state are nil, server-only or diagnosed instead of silently blank", async () => {
  const result = await renderTheme(
    theme(
      "article",
      "[{{ customer }}|{{ self }}|{{ current_tags }}|{{ handle }}|{{ articles['news/story-2'].title }}|{{ recommendations.performed? }}{{ recommendations.performed }}|{{ recommendations.products_count }}|{{ additional_checkout_buttons }}|{{ content_for_additional_checkout_buttons }}|{{ shop | login_button }}|{{ theme.name }}]",
    ),
    "/blogs/news/story-1",
  );
  assert.ok(
    result.html.includes("[|||story-1|Example Story 2|falsefalse|0|false|||]"),
    result.html,
  );
  assert.deepEqual(messages(result, "shopify-server-only"), [
    "Accelerated checkout buttons are omitted; they require Shopify's live checkout.",
    "The Shop login button is omitted; it requires Shopify's live account service.",
  ]);
  assert.deepEqual(messages(result, "not-implemented"), [
    "Global object theme is not available offline.",
  ]);
});

test("omitted shop metadata and policy aliases are missing data", async () => {
  const snapshot = defaultFixture();
  delete snapshot.shop.description;
  delete snapshot.shop.enabled_payment_types;
  delete snapshot.shop.policies;
  const result = await renderTheme(
    theme(
      "index",
      "[{{ shop.description }}|{{ shop.enabled_payment_types }}|{{ shop.refund_policy }}]",
    ),
    "/",
    { snapshot },
  );
  assert.deepEqual(messages(result, "missing-resource"), [
    "Object property shop.description is absent from the snapshot.",
    "Object property shop.enabled_payment_types is absent from the snapshot.",
    "Object property shop.refund_policy is absent from the snapshot.",
  ]);
  assert.deepEqual(messages(result, "not-implemented"), []);
});

test("metaobject handles cannot replace a definition's values; untyped field types are missing data", async () => {
  const snapshot = defaultFixture();
  snapshot.metaobjects = [
    { type: "t", handle: "values", fields: { q: "x" } },
    { type: "t", handle: "values_count", fields: { q: "y" } },
  ];
  const result = await renderTheme(
    theme(
      "index",
      "[{{ metaobjects.t.values_count }}|{% for e in metaobjects.t.values %}{{ e.q }}{% endfor %}|{{ metaobjects.t.values.first.q.type }}]",
    ),
    "/",
    { snapshot },
  );
  assert.ok(result.html.includes("[2|xy|]"), result.html);
  assert.deepEqual(messages(result, "missing-resource"), [
    "Object property metafield.type is absent from the snapshot.",
  ]);
});

test("price range bounds are documented filter values that report unknown properties", async () => {
  const snapshot = defaultFixture();
  snapshot.filters = [{ id: "filter.v.price", label: "Price", type: "price_range", values: [] }];
  const result = await renderTheme(
    theme(
      "collection",
      "{% for f in collection.filters %}[{{ f.min_value.param_name }}|{{ f.max_value.label }}]{% endfor %}",
    ),
    "/collections/sop-catalog",
    { snapshot },
  );
  assert.ok(result.html.includes("[filter.v.price.gte|]"), result.html);
  assert.deepEqual(messages(result, "not-implemented"), [
    "Object property filter_value.label is not available offline.",
  ]);
});

test("option values measure and serialize as their names", async () => {
  const result = await renderTheme(
    theme(
      "product",
      "{% assign o = product.options_with_values.first %}[{{ o.values.first | size }}|{{ o.values | json }}|{{ template | json }}]",
    ),
    product,
  );
  assert.ok(result.html.includes('[3|["Red","Blue"]|"product"]'), result.html);
  assert.deepEqual(result.diagnostics, []);
});
