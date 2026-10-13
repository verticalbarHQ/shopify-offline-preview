import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { instrumentLiquid } from "../tools/oracle/instrument.js";
import { summarizeHtml } from "../tools/oracle/summary.js";

const snapshot = defaultFixture();
const product = snapshot.products[0];
assert.ok(product);
const base = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/product.json": JSON.stringify({
    sections: {
      main: {
        type: "main",
        blocks: {
          group: {
            type: "group",
            settings: { heading: "Configured" },
            blocks: {
              label: { type: "label", settings: { text: "<h2>{{ closest.product.title }}</h2>" } },
            },
            block_order: ["label"],
          },
          static: { type: "label", static: true, settings: { text: "Static" } },
          disabled: { type: "label", disabled: true, settings: { text: "Hidden" } },
        },
        block_order: ["group", "disabled"],
      },
    },
    order: ["main"],
  }),
  "sections/main.liquid": `{% content_for 'blocks' %}{% content_for 'block', id: 'static', type: 'label' %}{% schema %}{"blocks":[{"type":"@theme"}]}{% endschema %}`,
  "blocks/group.liquid": `{{block.settings.heading}}{% capture children %}{% content_for 'blocks', closest.product: closest.product %}{% endcapture %}{% render 'wrapper', content: children %}{% schema %}{"tag":null,"settings":[{"type":"text","id":"heading","default":"Default"}]}{% endschema %}`,
  "snippets/wrapper.liquid": "<article>{{content}}</article>",
  "blocks/label.liquid": `{{block.settings.text}}{% schema %}{"tag":null,"settings":[{"type":"richtext","id":"text","default":"Default label"}]}{% endschema %}`,
};
test("dynamic, static and nested theme blocks preserve order, scope, settings and source ownership", async () => {
  const theme = new MemoryThemeFileSystem(base);
  const original = await theme.readText("blocks/label.liquid");
  const result = await renderTheme(theme, `/products/${product.handle}`, {
    snapshot,
    inspect: true,
  });
  assert.ok(result.html.includes(`Configured`));
  assert.ok(result.html.includes(`<h2>${product.title}</h2>`));
  assert.ok(result.html.includes("Static"));
  assert.ok(!result.html.includes("Hidden"));
  assert.equal(result.diagnostics.length, 0);
  const section = result.tree[0]?.children[0];
  assert.ok(section);
  assert.deepEqual(
    section.children.map((n) => n.type),
    ["group", "label"],
  );
  assert.equal(section.children[0]?.children[0]?.type, "label");
  assert.equal(section.children[0]?.children[1]?.kind, "snippet");
  const label = section.children[0]?.children[0];
  assert.ok(label);
  assert.equal(
    label.settingsPath,
    "templates/product.json#/sections/main/blocks/group/blocks/label",
  );
  assert.ok(result.dataUsed[label.id]?.includes("products[0].title"));
  assert.equal(await theme.readText("blocks/label.liquid"), original);
  const comparison = await renderTheme(
    new MemoryThemeFileSystem(
      Object.fromEntries(
        Object.entries(base).map(([path, text]) => [
          path,
          path.endsWith(".liquid") ? instrumentLiquid(text, path).source : text,
        ]),
      ),
    ),
    `/products/${product.handle}`,
    { snapshot, inspect: true },
  );
  const summary = summarizeHtml(comparison.html, {
    sectionTypes: { "template--N__main": "main" },
  }).summary;
  assert.equal(summary.markedBlockCount, 3);
  assert.equal(summary.tree[0]?.children[0]?.type, "group");
});
test("a static block can execute repeatedly with distinct nodes and isolated arbitrary parameters", async () => {
  const theme = new MemoryThemeFileSystem({
    ...base,
    "sections/main.liquid": `{% assign local='parent' %}{% for p in collection.products limit:2 %}{% content_for 'block',type:'label',id:'repeat',closest.product:p,label:p.title %}{% endfor %}`,
    "templates/collection.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "blocks/label.liquid": `{{label}}:{{closest.product.title}}:{{local}}{% schema %}{"tag":null}{% endschema %}`,
  });
  const result = await renderTheme(theme, "/collections/sop-catalog", { snapshot, inspect: true });
  const section = result.tree[0]?.children[0];
  assert.ok(section);
  assert.equal(section.children.length, 2);
  assert.notEqual(section.children[0]?.id, section.children[1]?.id);
  assert.ok(result.html.includes(`${product.title}:${product.title}:`));
  assert.ok(!result.html.includes(":parent"));
  assert.equal(result.diagnostics.length, 0);
});
test("unconfigured static blocks use their schema defaults and respect disabled configured blocks", async () => {
  const theme = new MemoryThemeFileSystem({
    ...base,
    "templates/product.json": JSON.stringify({
      sections: {
        main: { type: "main", blocks: { off: { type: "label", static: true, disabled: true } } },
      },
      order: ["main"],
    }),
    "sections/main.liquid": `{% content_for 'block',type:'label',id:'new' %}{% content_for 'block',type:'label',id:'off' %}`,
  });
  const result = await renderTheme(theme, `/products/${product.handle}`, { snapshot });
  assert.ok(result.html.includes("Default label"));
  assert.equal(result.tree[0]?.children[0]?.children.length, 1);
  assert.equal(result.diagnostics.length, 0);
});
test("invalid block types, order and recursive depth remain explicit Liquid errors", async () => {
  const theme = new MemoryThemeFileSystem({
    ...base,
    "templates/product.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{% content_for 'block',type:'loop',id:'loop' %}`,
    "blocks/loop.liquid": `{% content_for 'block',type:'loop',id:'loop' %}{% schema %}{"tag":null}{% endschema %}`,
  });
  const result = await renderTheme(theme, `/products/${product.handle}`, { snapshot });
  assert.ok(
    result.diagnostics.some((d) => d.code === "liquid-error" && d.message.includes("eight levels")),
  );
  const bad = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "sections/main.liquid": `{% content_for 'block',type:'../secret',id:'bad' %}`,
    }),
    `/products/${product.handle}`,
    { snapshot },
  );
  assert.ok(bad.diagnostics.some((d) => d.code === "liquid-error"));
});

test("content_for rejects dynamic ids, invalid kind literals and broken configured order", async () => {
  for (const tag of [
    "{% assign key='new' %}{% content_for 'block', type:'label', id:key %}",
    "{% content_for 'unknown' %}",
  ]) {
    const result = await renderTheme(
      new MemoryThemeFileSystem({ ...base, "sections/main.liquid": tag }),
      `/products/${product.handle}`,
      { snapshot },
    );
    assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
  }
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "templates/product.json": JSON.stringify({
        sections: {
          main: { type: "main", blocks: { label: { type: "label" } }, block_order: ["missing"] },
        },
        order: ["main"],
      }),
    }),
    `/products/${product.handle}`,
    { snapshot },
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "liquid-error" && d.message.includes("order")),
  );
});
