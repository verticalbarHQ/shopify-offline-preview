import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("a setting left out of a template takes its schema default, translated from the schema locale", async () => {
  const schema = {
    name: "Main",
    settings: [
      { type: "text", id: "heading", label: "Heading", default: "t:sections.main.heading" },
      { type: "text", id: "missing", label: "Missing", default: "t:sections.main.absent" },
      { type: "text", id: "set", label: "Set", default: "t:sections.main.heading" },
    ],
  };
  const theme = new MemoryThemeFileSystem({
    "templates/index.json":
      '{"layout":false,"sections":{"main":{"type":"main","settings":{"set":"Chosen"}}},"order":["main"]}',
    "sections/main.liquid": `{{ section.settings.heading }}|{{ section.settings.missing }}|{{ section.settings.set }}{% schema %}${JSON.stringify(schema)}{% endschema %}`,
    "locales/en.default.schema.json": '{"sections":{"main":{"heading":"Featured products"}}}',
  });
  const result = await renderTheme(theme, "/", { snapshot: defaultFixture() });
  assert.ok(result.html.includes("Featured products|t:sections.main.absent|Chosen"), result.html);
});
