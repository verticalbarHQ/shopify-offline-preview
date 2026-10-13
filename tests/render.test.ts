import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const fixture = defaultFixture();
const handle = fixture.products[0]?.handle;
const themeFiles = {
  "layout/theme.liquid":
    '<header>{% sections "header-group" %}</header><main>{{ content_for_layout }}</main><footer>{% section "footer" %}</footer>',
  "sections/header-group.json": JSON.stringify({
    type: "header",
    sections: { head: { type: "header" } },
    order: ["head"],
  }),
  "sections/header.liquid": 'Header{% schema %}{"tag":"header"}{% endschema %}',
  "sections/footer.liquid": "Footer",
  "templates/product.json": JSON.stringify({
    sections: {
      main: { type: "product", settings: { heading: "Configured" } },
      hidden: { type: "hidden", disabled: true },
      after: { type: "after" },
    },
    order: ["main", "hidden", "after"],
  }),
  "sections/product.liquid":
    '{% assign local_only = "parent" %}{{section.settings.heading}}:{% render "card", title: product.title %}:{% render "scope" %}{% schema %}{"settings":[{"type":"text","id":"heading","default":"Default"}]}{% endschema %}',
  "sections/after.liquid": "After",
  "snippets/card.liquid": "<b>{{title}}</b>{{section.settings.heading}}/{{settings.brand}}",
  "snippets/scope.liquid": "({{local_only}})",
  "config/settings_schema.json": JSON.stringify([
    { name: "brand", settings: [{ type: "text", id: "brand", default: "SOP" }] },
  ]),
  "config/settings_data.json": JSON.stringify({ current: {} }),
};

test("JSON order, disabled sections, groups, defaults and isolated snippets assemble with source tree", async () => {
  const theme = new MemoryThemeFileSystem(themeFiles);
  const before = await theme.readText("sections/product.liquid");
  const result = await renderTheme(theme, `/products/${handle}`, {
    snapshot: fixture,
    inspect: true,
  });
  assert.match(result.html, /Configured:<b>SOP Matrix Needle<\/b>Configured\/SOP:\(\)/);
  assert.ok(result.html.indexOf("Header") < result.html.indexOf("Configured"));
  assert.ok(result.html.indexOf("Configured") < result.html.indexOf("After"));
  assert.ok(result.html.indexOf("After") < result.html.indexOf("Footer"));
  const layout = result.tree[0];
  assert.equal(layout?.kind, "layout");
  assert.deepEqual(
    layout?.children.map((child) => child.type),
    ["header-group", "product", "after", "footer"],
  );
  const section = layout?.children[1];
  assert.deepEqual(
    section?.children.map((child) => child.file),
    ["snippets/card.liquid", "snippets/scope.liquid"],
  );
  assert.equal(section?.settingsPath, "templates/product.json#/sections/main");
  const card = section?.children[0];
  assert.ok(card && result.dataUsed[card.id]?.includes("products[0].title"));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(await theme.readText("sections/product.liquid"), before);
  assert.deepEqual(
    await renderTheme(theme, `/products/${handle}`, { snapshot: fixture, inspect: true }),
    result,
  );
});

test("no layout, schema defaults, missing references and unsupported filters remain observable", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": JSON.stringify({
      layout: false,
      sections: { a: { type: "basic", settings: { featured: "absent" } } },
      order: ["a"],
    }),
    "sections/basic.liquid":
      '{{section.settings.heading}}|{% if section.settings.featured == nil %}nil{% endif %}|{{"x" | image_url}}{% schema %}{"settings":[{"type":"text","id":"heading","default":"Default"},{"type":"product","id":"featured"}]}{% endschema %}',
  });
  const result = await renderTheme(theme, "/", { snapshot: fixture });
  assert.match(result.html, /Default\|nil\|\[not implemented: filter image_url\]/);
  assert.deepEqual(result.dataUsed, {});
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["missing-resource", "not-implemented"],
  );
  assert.equal(result.diagnostics[1]?.file, "sections/basic.liquid");
  assert.equal(result.tree[0]?.kind, "section");
});

test("unknown filters fail explicitly instead of being silently skipped", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": JSON.stringify({
        layout: false,
        sections: { a: { type: "error" } },
        order: ["a"],
      }),
      "sections/error.liquid": 'Before{{ "x" | unknown_filter }}After',
    }),
    "/",
    { snapshot: fixture },
  );
  // Strict filter validation happens at parse time. This file fails explicitly rather than quietly returning x.
  assert.match(result.html, /Liquid error \(sections\/error.liquid line 1\)/);
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
});

test("runtime errors render inline and preserve following outputs", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": JSON.stringify({
        layout: false,
        sections: { a: { type: "error" } },
        order: ["a"],
      }),
      "sections/error.liquid": 'Before{{ "%" | url_decode }}After',
    }),
    "/",
    { snapshot: fixture },
  );
  assert.match(result.html, /BeforeLiquid error.*After/);
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
});

test("snapshot now and timezone determine date output without host clock dependence", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": JSON.stringify({
        layout: false,
        sections: { a: { type: "date" } },
        order: ["a"],
      }),
      "sections/date.liquid": '{{ "now" | date: "%Y-%m-%d %H:%M" }}',
    }),
    "/",
    { snapshot: fixture },
  );
  const engineDate = new Date(fixture.meta.now);
  const expected = new Intl.DateTimeFormat("sv-SE", {
    timeZone: fixture.shop.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(engineDate);
  assert.ok(result.html.includes(expected));
});

test("style evaluates Liquid, doc parses without executing, and asset bodies preserve literal Liquid", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": JSON.stringify({
        layout: false,
        sections: { a: { type: "tags" } },
        order: ["a"],
      }),
      "sections/tags.liquid":
        '{% doc %}{% assign changed = "yes" %}{% enddoc %}{{changed}}{% style %}.x{width:{{2 | plus:3}}px}{% endstyle %}{% javascript %}console.log("{{2 | plus:3}}"){% endjavascript %}{% stylesheet %}.x{content:"{{2 | plus:3}}"}{% endstylesheet %}',
    }),
    "/",
    { snapshot: fixture },
  );
  assert.match(result.html, /<style data-shopify>\.x\{width:5px\}<\/style>/);
  assert.match(result.html, /<script>console.log\("\{\{2 \| plus:3\}\}"\)<\/script>/);
  assert.ok(!result.html.includes("yes"));
  assert.equal(result.diagnostics.filter((d) => d.code === "not-implemented").length, 2);
});

test("unsupported alias and nested snippet errors keep actual source paths and line numbers", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": JSON.stringify({
        layout: false,
        sections: { a: { type: "root" } },
        order: ["a"],
      }),
      "sections/root.liquid": "\n{% render 'error' %}",
      "snippets/error.liquid": '\n\n{{ "hello" | t }}\n{{ "%" | url_decode }}',
    }),
    "/",
    { snapshot: fixture },
  );
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "not-implemented" && d.file === "snippets/error.liquid" && d.line === 3,
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "liquid-error" && d.file === "snippets/error.liquid" && d.line === 4,
    ),
  );
});
