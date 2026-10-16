import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const files = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "sections/main.liquid": "{{powered_by_link}}",
};
test("powered_by_link renders Shopify attribution as a link with escaped translated text", async () => {
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/");
  assert.ok(
    result.html.includes(
      '<a target="_blank" rel="nofollow" href="https://www.shopify.com?utm_campaign=poweredby&amp;utm_medium=shopify&amp;utm_source=onlinestore">Powered by Shopify</a>',
    ),
  );
  assert.deepEqual(result.diagnostics, []);
  const snapshot = defaultFixture();
  snapshot.shop.locale = "fr";
  const localized = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "locales/fr.json": JSON.stringify({
        shopify: { links: { powered_by_shopify: "Fourni par <Shopify>" } },
      }),
    }),
    "/",
    { snapshot },
  );
  assert.ok(localized.html.includes("Fourni par &lt;Shopify&gt;</a>"));
  assert.ok(
    localized.diagnostics.some(
      (d) => d.code === "not-implemented" && d.message.includes("Localized Shopify marketing URLs"),
    ),
  );
});
