import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return new MemoryThemeFileSystem({
    "templates/product.json":
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  });
}

test("typed metafields expose value, type and list? and output their value", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields = {
    custom: {
      subtitle: { type: "single_line_text_field", value: "Hello" },
      sizes: { type: "list.single_line_text_field", value: ["S", "M"] },
      specs: { type: "json", value: { fabric: "Wool" } },
      legacy: "Plain",
    },
  };
  const result = await renderTheme(
    theme(
      "{% assign m = product.metafields.custom %}[{{ m.subtitle }}|{{ m.subtitle.value }}|{{ m.subtitle.type }}|{{ m.subtitle['list?'] }}][{{ m.sizes.value | join: '+' }}|{{ m.sizes['list?'] }}|{{ m.sizes }}][{{ m.specs.value.fabric }}][{{ m.legacy }}|{{ m.legacy.value }}]{% if m.subtitle == 'Hello' %}eq{% endif %}{{ m.absent }}",
    ),
    "/products/sop-matrix-needle",
    { snapshot },
  );
  assert.ok(
    result.html.includes(
      '[Hello|Hello|single_line_text_field|false][S+M|true|["S","M"]][Wool][Plain|]eq',
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});

test("metafield references are diagnosed instead of returning their raw identifier", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields = {
    custom: { related: { type: "product_reference", value: "sop-product-02" } },
  };
  const result = await renderTheme(
    theme("[{{ product.metafields.custom.related.value.title }}]"),
    "/products/sop-matrix-needle",
    { snapshot },
  );
  assert.ok(result.html.includes("[]"));
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    [
      "Metafield reference products[0].metafields.custom.related is not resolved to a resource offline.",
    ],
  );
});

test("metaobjects are available by type and handle with their entries", async () => {
  const snapshot = defaultFixture();
  snapshot.metaobjects = [
    {
      type: "testimonial",
      handle: "alpha",
      fields: { quote: { type: "single_line_text_field", value: "Great" }, author: "Ada" },
    },
    { type: "testimonial", handle: "beta", fields: { quote: "Fine" } },
  ];
  snapshot.blogs[0] = {
    ...snapshot.blogs[0],
    metafields: { custom: { tone: "calm" } },
  } as (typeof snapshot.blogs)[number];
  const result = await renderTheme(
    theme(
      "[{{ metaobjects.testimonial.alpha.quote }}|{{ metaobjects.testimonial.alpha.quote.value }}|{{ metaobjects.testimonial.alpha.author }}|{{ metaobjects.testimonial.alpha.system.type }}/{{ metaobjects.testimonial.alpha.system.handle }}|{{ metaobjects.testimonial.values_count }}|{% for t in metaobjects.testimonial.values %}{{ t.quote }};{% endfor %}|{{ metaobjects.testimonial.gamma.quote }}|{{ metaobjects.review.alpha }}|{{ blogs.news.metafields.custom.tone }}]",
    ),
    "/products/sop-matrix-needle",
    { snapshot },
  );
  assert.ok(
    result.html.includes("[Great|Great|Ada|testimonial/alpha|2|Great;Fine;|||calm]"),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});
