import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("/collections renders the list-collections template with the collections", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/list-collections.json":
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "templates/404.json":
      '{"layout":false,"sections":{"main":{"type":"missing"}},"order":["main"]}',
    "sections/main.liquid":
      "{{ page_title }}|{{ request.page_type }}|{{ template }}|{% for c in collections %}{{ c.handle }} {% endfor %}",
    "sections/missing.liquid": "missing",
  });
  const result = await renderTheme(theme, "/collections", { snapshot: defaultFixture() });
  assert.equal(result.route.template, "templates/list-collections.json");
  assert.ok(
    result.html.includes("Collections|list-collections|list-collections|sop-catalog "),
    result.html,
  );
});
