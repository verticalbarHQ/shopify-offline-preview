import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/product.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  });
}
test("live Shopify payment elements disclose omission without fake controls or credentials", async () => {
  const result = await renderTheme(
    theme(
      "{% form 'product',product %}Before{{form|payment_button}}|{{form|payment_terms}}After{% endform %}{% form 'cart',cart %}{{form|payment_terms}}{% endform %}",
    ),
    "/products/sop-matrix-needle",
  );
  assert.ok(result.html.includes("Before|After"));
  assert.equal(result.diagnostics.length, 2);
  assert.ok(
    result.diagnostics.every((d) => d.code === "shopify-server-only" && d.severity === "info"),
  );
  assert.ok(!result.html.includes("access-token"));
  assert.ok(!result.html.includes("accelerated-checkout"));
});
test("payment filters reject wrong form kinds and do not leak form ownership across scopes", async () => {
  const result = await renderTheme(
    theme(
      `{% form 'product',product %}{% assign saved=form %}{% endform %}{{form|payment_button}}|
{% form 'cart',cart %}{{form|payment_button}}{% endform %}|
{% form 'contact' %}{{form|payment_terms}}{% endform %}`,
    ),
    "/products/sop-matrix-needle",
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 3);
});
