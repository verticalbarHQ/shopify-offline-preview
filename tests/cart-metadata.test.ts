import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { applyScenario, validateSnapshotReferences } from "../packages/data/src/scenarios.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/cart.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  });
}
test("cart flags, indices, prepared keys and nested metadata retain false/null values and source reads", async () => {
  const snapshot = applyScenario(defaultFixture(), "with-items"),
    first = snapshot.cart.lines[0];
  assert.ok(first);
  first.instructions = { can_remove: false, can_update_quantity: false };
  const before = JSON.stringify(snapshot);
  const result = await renderTheme(
    theme(
      "{{cart.taxes_included}}|{{cart.duties_included}}|{% for item in cart.items %}{{item.index}}:{{item.instructions.can_remove}}:{{item.instructions.can_update_quantity}}:{{item.item_components.size}}:{% if item.parent_relationship == nil %}nil{% endif %}:{{item.url_to_remove}};{% endfor %}",
    ),
    "/cart",
    { snapshot, inspect: true },
  );
  assert.ok(
    result.html.includes(
      `false|false|0:false:false:0:nil:/cart/change?id=${first.key}&quantity=0;`,
    ),
  );
  assert.ok(result.html.includes("1:true:true:0:nil:"));
  assert.deepEqual(result.diagnostics, []);
  assert.ok(
    Object.values(result.dataUsed).flat().includes("cart.lines[0].instructions.can_remove"),
  );
  assert.equal(JSON.stringify(snapshot), before);
});
test("variant counts aggregate separate lines, accept IDs as strings or numbers and never lose precision", async () => {
  const snapshot = applyScenario(defaultFixture(), "with-items"),
    first = snapshot.cart.lines[0];
  assert.ok(first);
  snapshot.cart.lines.push({
    ...first,
    key: "sop-main-1:00000000000000000000000000000003",
    quantity: 3,
  });
  const result = await renderTheme(
    theme(
      `{{cart|item_count_for_variant:'${first.variantId}'}}|{{cart|item_count_for_variant:'missing'}}`,
    ),
    "/cart",
    { snapshot },
  );
  assert.ok(result.html.includes("5|0"));
  assert.deepEqual(result.diagnostics, []);
  const third = snapshot.cart.lines[2];
  assert.ok(third);
  third.key = first.key;
  assert.throws(() => validateSnapshotReferences(snapshot), /Duplicate cart line key/);
  const numeric = applyScenario(defaultFixture(), "with-items");
  const product = numeric.products[0],
    line = numeric.cart.lines[0],
    variant = product?.variants[0];
  assert.ok(variant && line);
  variant.id = "123";
  line.variantId = "123";
  line.key = "123:00000000000000000000000000000001";
  const numbers = await renderTheme(
    theme("{{cart|item_count_for_variant:123}}|{{cart|item_count_for_variant:'123'}}"),
    "/cart",
    { snapshot: numeric },
  );
  assert.ok(numbers.html.includes("2|2"));
  assert.deepEqual(numbers.diagnostics, []);
});
test("cart forms generate scoped multipart HTML while absent source flags and keys remain diagnosed", async () => {
  const snapshot = applyScenario(defaultFixture(), "with-items");
  delete snapshot.cart.taxesIncluded;
  delete snapshot.cart.dutiesIncluded;
  const line = snapshot.cart.lines[0];
  assert.ok(line);
  delete line.key;
  const result = await renderTheme(
    theme(
      `{% assign form='Outer' %}{% form 'cart',cart,id:'Own"form' %}{{form.posted_successfully?}}{% endform %}|{{form}}|{{cart.taxes_included}}|{{cart.duties_included}}|{{cart.items.first.key}}|{{cart.items.first.url_to_remove}}`,
    ),
    "/cart",
    { snapshot },
  );
  assert.ok(
    result.html.includes(
      'action="/cart" id="Own&quot;form" accept-charset="UTF-8" class="shopify-cart-form" enctype="multipart/form-data"',
    ),
  );
  assert.ok(result.html.includes('name="form_type" value="cart"'));
  assert.ok(result.html.includes("false</form>|Outer"));
  assert.equal(result.diagnostics.filter((d) => d.code === "not-implemented").length, 4);
  assert.ok(!result.diagnostics.some((d) => d.code === "liquid-error"));
});
