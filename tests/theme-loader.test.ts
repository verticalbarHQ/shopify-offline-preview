import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { ThemeLoader } from "../packages/render/src/theme-loader.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

// A render's theme files do not change, so a file's dependencies and a section's schema tags are read once per render,
// however many times the file is rendered (a card snippet in a product loop asked for them on every card).

test("reads each file's dependencies once per render, however often the file renders", async () => {
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{ content_for_layout }}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid":
      '{% for i in (1..40) %}{% render \'card\', i: i %}{% endfor %}{% schema %}{"name":"Main"}{% endschema %}',
    "snippets/card.liquid": "<b>{{ i }}</b>{% render 'price' %}",
    "snippets/price.liquid": "$",
  });
  const prototype = ThemeLoader.prototype as unknown as {
    readDependencies(file: string): string[];
  };
  const original = prototype.readDependencies;
  const reads: string[] = [];
  prototype.readDependencies = function (this: ThemeLoader, file: string) {
    reads.push(file);
    return original.call(this, file);
  };
  try {
    for (const staticPreview of [true, false]) {
      reads.length = 0;
      const result = await renderTheme(theme, "/", { staticPreview });
      assert.equal(result.html.split("<b>").length - 1, 40);
      assert.equal(
        new Set(reads).size,
        reads.length,
        `read more than once: ${JSON.stringify(reads)}`,
      );
      assert.ok(reads.includes("snippets/card.liquid"));
    }
  } finally {
    prototype.readDependencies = original;
  }
});

test("reads a section's schema tags once per render, and fails the same way for each instance", async () => {
  const loader = new ThemeLoader(
    new MemoryThemeFileSystem({
      "sections/a.liquid": 'x{% schema %}{"name":"A"}{% endschema %}',
      "sections/nested.liquid": '{% if true %}{% schema %}{"name":"N"}{% endschema %}{% endif %}',
    }),
    new Set(["sections/a.liquid", "sections/nested.liquid"]),
  );
  await loader.load(["sections/a.liquid", "sections/nested.liquid"]);
  const first = loader.schemaBodies("sections/a.liquid");
  assert.deepEqual(first, ['{"name":"A"}']);
  assert.equal(loader.schemaBodies("sections/a.liquid"), first);
  let failure: unknown;
  try {
    loader.schemaBodies("sections/nested.liquid");
  } catch (error) {
    failure = error;
  }
  assert.match(String(failure), /Schema tag must be top-level/);
  assert.throws(
    () => loader.schemaBodies("sections/nested.liquid"),
    (error) => error === failure,
  );
  assert.throws(
    () => loader.schemaBodies("sections/absent.liquid"),
    /Theme file not found: sections\/absent.liquid/,
  );
});

test("gives every section instance its own parsed schema from the shared tag bodies", async () => {
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{ content_for_layout }}",
    "templates/index.json":
      '{"sections":{"one":{"type":"s","settings":{"t":"first"}},"two":{"type":"s"}},"order":["one","two"]}',
    "sections/s.liquid":
      '[{{ section.settings.t }}]{% schema %}{"name":"S","settings":[{"type":"text","id":"t","label":"T","default":"fallback"}]}{% endschema %}',
  });
  const result = await renderTheme(theme, "/", { staticPreview: true });
  assert.match(result.html, /\[first\][\s\S]*\[fallback\]/);
});
