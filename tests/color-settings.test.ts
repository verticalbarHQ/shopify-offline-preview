import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const schema = [
  {
    name: "Own colors",
    settings: [
      {
        type: "color_scheme_group",
        id: "color_schemes",
        definition: [
          { type: "color", id: "background", default: "#334fb4" },
          { type: "color", id: "text", default: "#fff" },
        ],
      },
      { type: "color_scheme", id: "card", default: "two" },
    ],
  },
];
const base = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/index.json":
    '{"sections":{"main":{"type":"main","settings":{"scheme":"one"}}},"order":["main"]}',
  "config/settings_schema.json": JSON.stringify(schema),
  "config/settings_data.json": JSON.stringify({
    current: {
      color_schemes: {
        one: { settings: { background: "#123456" } },
        two: { settings: { text: "rgba(255, 255, 255, 0.5)" } },
      },
    },
  }),
};
test("scheme groups enumerate color objects, retain ids and defaults, and resolve section references", async () => {
  const theme = new MemoryThemeFileSystem({
    ...base,
    "sections/main.liquid": `{% for scheme in settings.color_schemes %}{{scheme.id}}={{scheme.settings.background}}:{{scheme.settings.background.rgb}};{% endfor %}|{{settings.card}}|{{settings.color_schemes['one'].settings.background.red}}|{{section.settings.scheme.id}}{% schema %}{"settings":[{"type":"color_scheme","id":"scheme","default":"two"}]}{% endschema %}`,
  });
  const result = await renderTheme(theme, "/");
  assert.ok(result.html.includes("one=#123456:18 52 86;two=#334fb4:51 79 180;|two|18|one"));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    await theme.readText("config/settings_data.json"),
    base["config/settings_data.json"],
  );
});
test("invalid and absent scheme references follow declared-default, first-scheme and nil fallbacks", async () => {
  const defs = JSON.parse(JSON.stringify(schema));
  defs[0].settings.push({ type: "color_scheme", id: "bad", default: "missing" });
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "config/settings_schema.json": JSON.stringify(defs),
      "config/settings_data.json": JSON.stringify({
        current: { color_schemes: { one: { settings: {} } }, card: "missing" },
      }),
      "sections/main.liquid": "{{settings.card}}|{{settings.bad}}",
    }),
    "/",
  );
  assert.ok(result.html.includes(">one|one</div>"));
  assert.deepEqual(result.diagnostics, []);
  const absent = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "config/settings_data.json": '{"current":{}}',
      "sections/main.liquid":
        "{% if settings.card == nil %}None{% endif %}{% for scheme in settings.color_schemes %}NEVER{% endfor %}",
    }),
    "/",
  );
  assert.ok(absent.html.includes(">None</div>"));
  assert.deepEqual(absent.diagnostics, []);
});
test("colors expose documented RGB/HSL/alpha properties and unsupported formats or properties remain diagnosed", async () => {
  const theme = new MemoryThemeFileSystem({
    ...base,
    "sections/main.liquid":
      "{{settings.color_schemes.two.settings.background.hue}}|{{settings.color_schemes.two.settings.background.saturation}}|{{settings.color_schemes.two.settings.background.lightness}}|{{settings.color_schemes.two.settings.text.alpha}}|{{settings.color_schemes.two.settings.text.rgba}}|{{settings.color_schemes.two.settings.background.chroma}}",
  });
  const result = await renderTheme(theme, "/");
  assert.ok(result.html.includes(">227|56|45|0.5|255 255 255 / 0.5|</div>"));
  assert.ok(
    result.diagnostics.some((d) => d.code === "not-implemented" && d.message.includes("chroma")),
  );
  const unknown = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "config/settings_data.json": JSON.stringify({
        current: { color_schemes: { one: { settings: { background: "oklch(50% 0.1 200)" } } } },
      }),
      "sections/main.liquid": "{{settings.color_schemes.one.settings.background}}",
    }),
    "/",
  );
  assert.ok(
    unknown.diagnostics.some((d) => d.code === "not-implemented" && d.message.includes("format")),
  );
});
