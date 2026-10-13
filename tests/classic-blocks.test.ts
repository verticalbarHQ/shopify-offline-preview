import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const snapshot = defaultFixture();
const product = snapshot.products[0];
assert.ok(product);
const files = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/product.json": JSON.stringify({
    sections: {
      main: {
        type: "main",
        blocks: {
          a: { type: "text", settings: { label: "A" } },
          b: { type: "text", settings: { label: "B" } },
          off: { type: "text", disabled: true },
        },
        block_order: ["b", "a", "off"],
      },
    },
    order: ["main"],
  }),
  "sections/main.liquid": `{% for block in section.blocks %}<p {{block.shopify_attributes}}>{{block.settings.label}}:{{product.title}}{% render 'label', value:block.settings.label %}</p>{% endfor %}{% schema %}{"blocks":[{"type":"text","settings":[{"id":"label","type":"text","default":"Default"}]}]}{% endschema %}`,
  "snippets/label.liquid": "<span>{{value}}</span>",
};
test("classic executions own their snippets and source reads without rewriting theme files", async () => {
  const theme = new MemoryThemeFileSystem(files);
  const result = await renderTheme(theme, `/products/${product.handle}`, {
    snapshot,
    inspect: true,
  });
  const blocks = result.tree[0]?.children[0]?.children;
  assert.ok(blocks);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.kind, "block");
  assert.equal(blocks[0]?.settingsPath, "templates/product.json#/sections/main/blocks/b");
  assert.equal(blocks[0]?.file, "sections/main.liquid");
  assert.equal(blocks[0]?.children[0]?.file, "snippets/label.liquid");
  assert.ok(result.dataUsed[blocks[0]?.id ?? ""]?.includes("products[0].title"));
  assert.ok(result.html.indexOf(`B:${product.title}`) < result.html.indexOf(`A:${product.title}`));
  assert.equal((result.html.match(/<!--sop:region /g) ?? []).length, 2);
  assert.ok(!result.html.includes("data-shopify-editor-block"));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(await theme.readText("sections/main.liquid"), files["sections/main.liquid"]);
  const design = await renderTheme(theme, `/products/${product.handle}`, {
    snapshot,
    designMode: true,
  });
  assert.ok(design.html.includes("data-shopify-editor-block"));
});
test("native loop limit, offset, reversal, continue, break and subsequent scopes are preserved", async () => {
  const source = `{% for block in section.blocks reversed %}{% if block.id=='a' %}{% continue %}{% endif %}{{block.id}}{% break %}NEVER{% endfor %}|{% for block in section.blocks offset:1 limit:1 %}{{block.id}}{% endfor %}|{% for n in (1..3) %}{{n}}{% endfor %}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "sections/main.liquid":
        source +
        files["sections/main.liquid"].slice(files["sections/main.liquid"].indexOf("{% schema %}")),
    }),
    `/products/${product.handle}`,
    { snapshot },
  );
  assert.ok(!result.html.includes("NEVER"));
  assert.match(
    result.html,
    /b<!--\/sop:region-->\|<!--sop:region sop-\d+-->a<!--\/sop:region-->\|123/,
  );
  assert.equal(result.tree[0]?.children[0]?.children.length, 3);
  assert.deepEqual(result.diagnostics, []);
});
test("tracing keeps block loops inside attributes and scripts free of injected comments", async () => {
  const source = `<div data-ids="{% for block in section.blocks %}{{block.id}}{% endfor %}">Text</div><script>window.ids='{% for block in section.blocks %}{{block.id}}{% endfor %}';</script>`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "sections/main.liquid":
        source +
        files["sections/main.liquid"].slice(files["sections/main.liquid"].indexOf("{% schema %}")),
    }),
    `/products/${product.handle}`,
    { snapshot },
  );
  assert.ok(
    result.html.includes('<div data-ids="ba">Text</div>'),
    result.html + JSON.stringify(result.diagnostics),
  );
  assert.ok(result.html.includes("<script>window.ids='ba';</script>"));
  assert.ok(!result.html.includes("sop:region"));
  assert.equal(result.tree[0]?.children[0]?.children.length, 4);
  assert.deepEqual(result.diagnostics, []);
});

test("classic setting expressions resolve against the active section context", async () => {
  const config = JSON.parse(files["templates/product.json"]);
  config.sections.main.blocks.b.settings.label = "{{closest.product.title}}";
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...files, "templates/product.json": JSON.stringify(config) }),
    `/products/${product.handle}`,
    { snapshot, inspect: true },
  );
  const block = result.tree[0]?.children[0]?.children[0];
  assert.ok(block);
  assert.ok(result.html.includes(`${product.title}:${product.title}`));
  assert.ok(result.dataUsed[block.id]?.includes("products[0].title"));
  assert.deepEqual(result.diagnostics, []);
});
