import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { resolveRoute } from "../packages/render/src/routes.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("captured Liquid templates render their saved resource through the default layout", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  const files = {
    "templates/product.liquid":
      '{% assign saved_title = product.title %}<h1>{{ saved_title }}</h1>{% render "detail", title: saved_title %}',
    "snippets/detail.liquid": "<p>{{ title }}</p>",
    "layout/theme.liquid":
      "<main>{{ content_for_layout }}</main><footer>{{ saved_title }}</footer>",
  };
  const before = structuredClone({ snapshot, files });
  const result = await renderTheme(
    new MemoryThemeFileSystem(files),
    `/products/${product.handle}`,
    {
      snapshot,
      inspect: true,
    },
  );
  assert.equal(result.route.template, "templates/product.liquid");
  assert.match(result.html, /<main><h1>SOP Matrix Needle<\/h1><p>SOP Matrix Needle<\/p><\/main>/);
  assert.match(result.html, /<footer>SOP Matrix Needle<\/footer>/);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual({ snapshot, files }, before);
});

test("Liquid layout declarations select a captured layout or no layout", async () => {
  const snapshot = defaultFixture();
  for (const [declaration, expected] of [
    ["{% layout 'wide' %}", "<article>Saved</article>"],
    ["{% layout none %}", "Saved"],
    ["{% liquid\n layout 'wide'\n %}", "<article>Saved</article>"],
    ["{% if false %}{% layout 'missing' %}{% else %}{% layout none %}{% endif %}", "Saved"],
  ]) {
    const result = await renderTheme(
      new MemoryThemeFileSystem({
        "templates/index.liquid": `${declaration}Saved`,
        "layout/wide.liquid": "<article>{{ content_for_layout }}</article>",
      }),
      "/",
      { snapshot },
    );
    assert.equal(result.html.trim(), expected);
    assert.deepEqual(result.diagnostics, []);
  }
});

test("Liquid templates preserve static sections, settings, fonts and recoverable errors", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.liquid":
        "{% layout none %}<h1>Saved</h1>{% section 'saved' %}{{ '%' | url_decode }}<p>After</p>",
      "sections/saved.liquid":
        "<b>{{ section.settings.title }}</b>{{ settings.body_font.family }}:{{ settings.body_font.weight }}",
      "config/settings_data.json": JSON.stringify({
        current: {
          body_font: "helvetica_n7",
          sections: { saved: { settings: { title: "Original" } } },
        },
      }),
      "config/settings_schema.json": JSON.stringify([
        { name: "Fonts", settings: [{ type: "font_picker", id: "body_font" }] },
      ]),
    }),
    "/",
    { snapshot: defaultFixture() },
  );
  assert.match(result.html, /<h1>Saved<\/h1>/);
  assert.match(result.html, /<b>Original<\/b>Helvetica:700/);
  assert.match(result.html, /Liquid error \(templates\/index line 1\)/);
  assert.match(result.html, /<p>After<\/p>/);
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});

test("a missing or escaping Liquid layout remains a failure without a default substitute", async () => {
  for (const name of ["missing", "../secret"]) {
    await assert.rejects(
      renderTheme(
        new MemoryThemeFileSystem({
          "templates/index.liquid": `{% layout '${name}' %}Saved`,
          "layout/theme.liquid": "Unexpected default {{ content_for_layout }}",
        }),
        "/",
        { snapshot: defaultFixture() },
      ),
    );
  }
});

test("route selection keeps assigned Liquid ahead of default JSON and falls back across formats", () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.templateSuffix = "saved";
  const files = new Set(["templates/product.saved.liquid", "templates/product.json"]);
  const has = (file: string) => files.has(file);
  let route = resolveRoute(snapshot, `/products/${product.handle}`, has);
  assert.equal(route.template, "templates/product.saved.liquid");
  assert.deepEqual(route.diagnostics, []);
  route = resolveRoute(snapshot, `/products/${product.handle}?view=missing`, has);
  assert.equal(route.template, "templates/product.saved.liquid");
  assert.equal(route.diagnostics.length, 1);
  files.delete("templates/product.saved.liquid");
  assert.equal(
    resolveRoute(snapshot, `/products/${product.handle}`, has).template,
    "templates/product.json",
  );
  files.delete("templates/product.json");
  files.add("templates/product.liquid");
  assert.equal(
    resolveRoute(snapshot, `/products/${product.handle}`, has).template,
    "templates/product.liquid",
  );
});
