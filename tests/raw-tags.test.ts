import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const snapshot = defaultFixture();
const base = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
};
test("schemas, docs and raw assets retain literal Liquid without lexing their contents", async () => {
  const schema = JSON.stringify({
    settings: [
      {
        type: "text",
        id: "label",
        default: "Visible",
        visible_if: '{{ block.settings.label == "custom" }}',
      },
    ],
  });
  const doc = "Must be inside a {% style %} rule. {{ output not closed\n{% render 'missing' %}";
  const css = 'p::after { content: "{{ output not closed"; }';
  const js = 'window.literal="{{ output not closed";';
  const files = {
    ...base,
    "sections/main.liquid": `{{section.settings.label}}{% doc %}${doc}{% enddoc %}{% render 'raw' %}{% schema %}${schema}{% endschema %}`,
    "snippets/raw.liquid": `{% doc %}${doc}{% enddoc %}{% stylesheet %}${css}{% endstylesheet %}{% javascript %}${js}{% endjavascript %}`,
  };
  const theme = new MemoryThemeFileSystem(files);
  const result = await renderTheme(theme, "/", { snapshot });
  assert.ok(result.html.includes("Visible"));
  assert.ok(result.html.includes(`<style>${css}</style>`));
  assert.ok(result.html.includes(`<script>${js}</script>`));
  assert.ok(!result.html.includes("Must be inside"));
  assert.ok(!result.html.includes("visible_if"));
  assert.ok(!result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.equal(await theme.readText("sections/main.liquid"), files["sections/main.liquid"]);
});
test("raw tag tokenization preserves whitespace control and original snippet source lines", async () => {
  const files = {
    ...base,
    "sections/main.liquid": "{% render 'raw' %}",
    "snippets/raw.liquid":
      "Top  {%- doc -%}\n{% style %} example\n{% enddoc -%}\nNext\n{{ 'x' | image_url }}",
  };
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/", { snapshot });
  assert.ok(
    result.html.includes("TopNext"),
    JSON.stringify({ html: result.html, diagnostics: result.diagnostics }),
  );
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "liquid-error" && d.file === "snippets/raw.liquid" && d.line === 5,
    ),
    JSON.stringify(result.diagnostics),
  );
});
test("render with, for, default aliases and named bindings remain isolated and source-tracked", async () => {
  const product = snapshot.products[0];
  assert.ok(product);
  const files = {
    ...base,
    "templates/collection.json": base["templates/index.json"],
    "sections/main.liquid":
      "{% assign parent_only='hidden' %}{% assign items=collection.products | slice:0,2 %}{% render 'card' with items.first as chosen, label:'With' %}|{% render 'row' for items as item, label:'For' %}|{% render 'implicit' with items.first %}",
    "snippets/card.liquid": "{{label}}:{{chosen.title}}:{{parent_only}}",
    "snippets/row.liquid":
      "{{label}}:{{item.title}}:{{forloop.index}}/{{forloop.length}}:{{forloop.first}}:{{forloop.last}}:{{parent_only}};",
    "snippets/implicit.liquid": "{{implicit.title}}",
  };
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/collections/sop-catalog", {
    snapshot,
    inspect: true,
  });
  assert.ok(result.html.includes(`With:${product.title}:|For:${product.title}:1/2:true:false:;`));
  assert.ok(result.html.includes(":2/2:false:true:;"));
  assert.ok(!result.html.includes("hidden"));
  assert.deepEqual(result.diagnostics, []);
  const children = result.tree[0]?.children[0]?.children;
  assert.ok(children);
  assert.deepEqual(
    children.map((n) => n.file),
    ["snippets/card.liquid", "snippets/row.liquid", "snippets/implicit.liquid"],
  );
  assert.ok(result.dataUsed[children[0]?.id ?? ""]?.includes("products[0].title"));
  assert.ok(result.dataUsed[children[1]?.id ?? ""]?.includes("products[1].title"));
});

test("render for nil invokes no snippet body", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "sections/main.liquid": "Before{% render 'row' for nil as item %}After",
      "snippets/row.liquid": "NEVER",
    }),
    "/",
    { snapshot },
  );
  assert.ok(result.html.includes("BeforeAfter"));
  assert.ok(!result.html.includes("NEVER"));
  assert.deepEqual(result.diagnostics, []);
});
