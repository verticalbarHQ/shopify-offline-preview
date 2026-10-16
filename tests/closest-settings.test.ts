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
