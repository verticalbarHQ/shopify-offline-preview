import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("resource list settings resolve ordered resource drops in global, section and block scopes", async () => {
  const snapshot = defaultFixture();
  const collections = snapshot.collections
    .slice(0, 2)
    .map((c) => c.handle)
    .reverse();
  const products = snapshot.products
    .slice(0, 2)
    .map((p) => p.handle)
    .reverse();
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid":
      "{{ settings.picks | map: 'handle' | join: ',' }}|{{content_for_layout}}",
    "config/settings_schema.json": '[{"settings":[{"id":"picks","type":"product_list"}]}]',
    "config/settings_data.json": JSON.stringify({ current: { picks: products } }),
    "templates/index.json": JSON.stringify({
      sections: {
        main: {
          type: "main",
          settings: { picks: [...collections, "missing"] },
          blocks: { list: { type: "list", settings: { picks: products } } },
          block_order: ["list"],
        },
      },
      order: ["main"],
    }),
    "sections/main.liquid": `{{section.settings.picks | map:'handle' | join:','}}|{% content_for 'blocks' %}{% schema %}{"settings":[{"id":"picks","type":"collection_list"}]}{% endschema %}`,
    "blocks/list.liquid": `{{block.settings.picks | map:'handle' | join:','}}|{{block.settings.empty.size}}{% if block.settings.empty == blank %}:blank{% endif %}{% schema %}{"tag":null,"settings":[{"id":"picks","type":"product_list"},{"id":"empty","type":"collection_list"}]}{% endschema %}`,
  });
  const result = await renderTheme(theme, "/", { snapshot });
  assert.ok(result.html.includes(products.join(",") + "|"));
  assert.ok(result.html.includes(collections.join(",") + "|"));
  assert.ok(result.html.includes(products.join(",") + "|0:blank"));
  assert.equal(result.diagnostics.filter((d) => d.code === "missing-resource").length, 1);
  assert.ok(!result.diagnostics.some((d) => d.code === "not-implemented"));
});
