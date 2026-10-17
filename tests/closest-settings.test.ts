import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("closest resolves section and nested block pickers, explicit overrides and empty selections", async () => {
  const snapshot = defaultFixture();
  snapshot.collections.push({
    ...snapshot.collections[0]!,
    id: "second-id",
    handle: "second",
    title: "Second",
  });
  const [first, second] = snapshot.collections;
  assert.ok(first && second);
  const make = (selected: string) =>
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/index.json": JSON.stringify({
        sections: {
          main: {
            type: "main",
            settings: { featured: first.handle },
            blocks: {
              group: {
                type: "group",
                settings: { featured: selected },
                blocks: {
                  label: { type: "label", settings: { featured: "{{closest.collection}}" } },
                },
                block_order: ["label"],
              },
            },
          },
        },
        order: ["main"],
      }),
      "sections/main.liquid": `{% content_for 'block',type:'label',id:'section-child' %}|{% content_for 'block',type:'group',id:'group' %}|{% content_for 'block',type:'label',id:'override',closest.collection:collections['${second.handle}'] %}|{% content_for 'block',type:'label',id:'nil',closest.collection:nil %}{% schema %}{"settings":[{"id":"featured","type":"collection"}]}{% endschema %}`,
      "blocks/group.liquid": `{% content_for 'blocks' %}{% schema %}{"tag":null,"settings":[{"id":"featured","type":"collection"}]}{% endschema %}`,
      "blocks/label.liquid": `[{{closest.collection.handle}}:{% if closest.collection.products_count > 0 %}View all{% endif %}]{{block.settings.copy}}{% schema %}{"tag":null,"settings":[{"id":"featured","type":"collection","default":"{{closest.collection}}"},{"id":"copy","type":"text","default":"{{closest.collection.title}}"}]}{% endschema %}`,
    });
  let result = await renderTheme(make(second.handle), "/", { snapshot, inspect: true });
  assert.deepEqual(result.html.match(/\[[^\]]+\]/g), [
    `[${first.handle}:View all]`,
    `[${second.handle}:View all]`,
    `[${second.handle}:View all]`,
    "[:]",
  ]);
  assert.deepEqual(result.diagnostics, []);
  result = await renderTheme(make(""), "/", { snapshot });
  assert.deepEqual(result.html.match(/\[[^\]]+\]/g), [
    `[${first.handle}:View all]`,
    "[:]",
    `[${second.handle}:View all]`,
    "[:]",
  ]);
});

test("an explicit closest value keeps any resource and drops a string, number or list", async () => {
  // The values a development store showed for each argument (2026-10-17).
  const cases: [string, string][] = [
    ["t", "[blank||blank|]"],
    ["s[1]", "[blank||blank|]"],
    ["nil", "[blank||blank|]"],
    ["n", "[blank||blank|]"],
    ["s", "[blank||blank|]"],
    ["5.0", "[blank||blank|]"],
    ["(1..3)", "[blank||blank|]"],
    ["p", "[set|SOP Matrix Needle|blank|]"],
    ["c", "[set|Example Catalog|blank|]"],
  ];
  const calls = cases
    .map(
      ([value], index) =>
        `<p>{% content_for 'block', type: 'probe', id: 'c${index}', closest.product: ${value} %}</p>`,
    )
    .join("");
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{%- assign s = 'a,b' | split: ',' -%}{%- assign t = 'abc' -%}{%- assign n = 5 -%}{%- assign p = all_products['sop-matrix-needle'] -%}{%- assign c = collections['sop-catalog'] -%}${calls}<p>{% content_for 'block', type: 'probe', id: 'w', closest.collection: p %}</p>`,
    "blocks/probe.liquid":
      "[{% if closest.product == blank %}blank{% else %}set{% endif %}|{{ closest.product.title }}|{% if closest.collection == blank %}blank{% else %}set{% endif %}|{{ closest.collection.title }}]{% schema %}{}{% endschema %}",
  });
  const { html } = await renderTheme(theme, "/", { snapshot: defaultFixture() });
  const actual = [...html.matchAll(/<p>(.*?)<\/p>/gs)].map((m) =>
    m[1]?.replace(/<[^>]*>/g, "").trim(),
  );
  assert.deepEqual(actual, [
    ...cases.map(([, expected]) => expected),
    "[blank||set|SOP Matrix Needle]",
  ]);
});
