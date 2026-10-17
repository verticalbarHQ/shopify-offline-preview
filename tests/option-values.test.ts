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

test("option values are product_option_value objects derived from the selected variant", async () => {
  // sop-main-7 is Blue/Large/Cotton; only Blue/Large/Linen (sop-main-8) is unavailable.
  const result = await renderTheme(
    theme(
      "{% for o in product.options_with_values %}{{o.name}}={{o.selected_value}}:{% for v in o.values %}[{{v}}|{{v.name}}|{{v.available}}|{{v.selected}}|{{v.variant.id}}|{{v.product_url}}]{% endfor %};{% endfor %}{% if product.options_with_values.first.values.first == 'Red' %}eq{% endif %}{% if product.options_with_values.first.values contains 'Blue' %}|has{% endif %}|{{ product.options_with_values.last.values.first.size }}",
    ),
    "/products/sop-matrix-needle?variant=sop-main-7",
    { snapshot: defaultFixture() },
  );
  assert.ok(
    result.html.includes(
      "Color=Blue:[Red|Red|true|false|sop-main-3|][Blue|Blue|true|true|sop-main-7|];" +
        "Size=Large:[Small|Small|true|false|sop-main-5|][Large|Large|true|true|sop-main-7|];" +
        "Material=Cotton:[Cotton|Cotton|true|true|sop-main-7|][Linen|Linen|false|false|sop-main-8|];eq|has|6",
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});

test("option value availability follows earlier selections and missing ids stay diagnosed", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product?.options[0]);
  delete product.options[0].valueIds;
  for (const variant of product.variants)
    variant.available = variant.optionValues.some((value) => value.value === "Blue");
  const result = await renderTheme(
    theme(
      "{% for v in product.options_with_values.first.values %}[{{v}}:{{v.available}}:{{v.selected}}]{% endfor %}{{ product.options_with_values.first.values.first.id }}",
    ),
    "/products/sop-matrix-needle",
    { snapshot, inspect: true },
  );
  // No variant is selected, so the first available (Blue) variant supplies the selection.
  assert.ok(result.html.includes("[Red:false:false][Blue:true:true]"), result.html);
  assert.deepEqual(
    result.diagnostics.map((d) => d.message),
    ["Object property product_option_value.id is absent from the snapshot."],
  );
  assert.ok(Object.values(result.dataUsed).flat().includes("products[0].options[0].values[0]"));
});
