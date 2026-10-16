import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("cart equality with empty follows source line quantities in both operand orders", async () => {
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid":
      '<span class="cart-bubble{% if cart == empty %} hidden{% endif %}">{{cart.item_count}}</span>{% if empty == cart %}empty{% endif %}{% if cart != empty %}filled{% endif %}',
  });
  const snapshot = defaultFixture();
  snapshot.cart.lines = [];
  let result = await renderTheme(theme, "/", { snapshot });
  assert.ok(result.html.includes('class="cart-bubble hidden">0</span>empty'));
  assert.deepEqual(result.diagnostics, []);
  const product = snapshot.products[0]!;
  snapshot.cart.lines = [
    { productHandle: product.handle, variantId: product.variants[0]!.id, quantity: 2 },
  ];
  result = await renderTheme(theme, "/", { snapshot });
  assert.ok(result.html.includes('class="cart-bubble">2</span>filled'));
  assert.deepEqual(result.diagnostics, []);
});
