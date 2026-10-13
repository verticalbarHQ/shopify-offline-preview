import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const definitions = [
  {
    type: "color_palette",
    id: "colors",
    default: { primary: "#334fb4", secondary: "#fff", new_color: "#f00" },
  },
  { type: "color", id: "heading", default: "{{ settings.colors.primary }}" },
  {
    type: "color_background",
    id: "gradient",
    default:
      "linear-gradient(90deg, {{ settings.colors.primary }}, {{ settings.colors.secondary }})",
  },
];
const base = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
  "config/settings_schema.json": JSON.stringify([{ name: "Own palette", settings: definitions }]),
  "config/settings_data.json": JSON.stringify({
    current: {
      colors: { primary: "#123456", legacy: "{{ settings.colors.secondary }}", secondary: "#000" },
    },
  }),
};
test("palettes merge added defaults, preserve merchant values, resolve deleted-color references and iterate values in JSON order", async () => {
  const theme = new MemoryThemeFileSystem({
    ...base,
    "sections/main.liquid":
      "{{settings.heading}}:{{settings.heading.rgb}}|{{settings.colors.legacy.rgb}}|{% for color in settings.colors %}{{color}};{% endfor %}|{{settings.gradient}}",
  });
  const result = await renderTheme(theme, "/");
  assert.ok(
    result.html.includes(
      "#123456:18 52 86|0 0 0|#123456;#000000;#000000;#ff0000;|linear-gradient(90deg, #123456, #000000)",
    ),
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    await theme.readText("config/settings_data.json"),
    base["config/settings_data.json"],
  );
});
test("palette lookups keep reserved JS property names as data without prototype mutation", async () => {
  const theme = new MemoryThemeFileSystem({
    ...base,
    "config/settings_schema.json": JSON.stringify([
      {
        name: "Own",
        settings: [
          {
            type: "color_palette",
            id: "colors",
            default: { constructor: "#fff", length: "#123456" },
          },
        ],
      },
    ]),
    "config/settings_data.json": '{"current":{}}',
    "sections/main.liquid":
      "{{settings.colors.constructor.rgb}}|{{settings.colors.length.rgb}}|{% for color in settings.colors %}{{color}};{% endfor %}",
  });
  const result = await renderTheme(theme, "/");
  assert.ok(result.html.includes("255 255 255|18 52 86|#ffffff;#123456;"));
  assert.deepEqual(result.diagnostics, []);
});
test("palette and global setting reference cycles fail visibly without recursive hangs", async () => {
  const cyclic = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "config/settings_data.json": JSON.stringify({
        current: {
          colors: {
            primary: "{{ settings.colors.secondary }}",
            secondary: "{{ settings.colors.primary }}",
          },
        },
      }),
      "sections/main.liquid": "{{settings.colors.primary}}After",
    }),
    "/",
  );
  assert.ok(
    cyclic.diagnostics.some(
      (d) => d.code === "liquid-error" && d.message.includes("Cyclic color palette"),
    ),
  );
  assert.ok(cyclic.html.includes("After"));
  const global = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "config/settings_schema.json": JSON.stringify([
        { name: "Own", settings: [{ type: "text", id: "cycle", default: "{{settings.cycle}}" }] },
      ]),
      "config/settings_data.json": '{"current":{}}',
      "sections/main.liquid": "{{settings.cycle}}After",
    }),
    "/",
  );
  assert.ok(
    global.diagnostics.some(
      (d) => d.code === "liquid-error" && d.message.includes("Cyclic dynamic setting"),
    ),
  );
  assert.ok(global.html.includes("After"));
});

test("empty background values stay empty and Liquid logic in settings remains explicit", async () => {
  const defs = [
    { type: "color_background", id: "empty" },
    { type: "text", id: "logic", default: "{% if true %}Hidden{% endif %}" },
  ];
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "config/settings_schema.json": JSON.stringify([{ name: "Own", settings: defs }]),
      "config/settings_data.json": '{"current":{}}',
      "sections/main.liquid": "{% if settings.empty==empty %}Empty{% endif %}|{{settings.logic}}",
    }),
    "/",
  );
  assert.ok(result.html.includes(">Empty|</div>"));
  assert.ok(
    result.diagnostics.some(
      (d) => d.code === "not-implemented" && d.message.includes("Liquid logic"),
    ),
  );
});
