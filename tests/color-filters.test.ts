import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const base = {
  "layout/theme.liquid": "{{content_for_layout}}",
  "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
};
test("component modification matches RGB, alpha and HSL reference outputs and preserves RGB syntax", async () => {
  const source = `{{'#EA5AB9'|color_modify:'red',255}}|{{'#EA5AB9'|color_modify:'alpha',0.85}}|{{'#EA5AB9'|color_modify:'hue',60}}|{{'#EA5AB9'|color_modify:'saturation',30}}|{{'#EA5AB9'|color_modify:'lightness',50}}|{{'rgba(234,90,185,0.5)'|color_modify:'alpha',1}}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...base, "sections/main.liquid": source }),
    "/",
  );
  assert.ok(
    result.html.includes(
      "#ff5ab9|rgba(234, 90, 185, 0.85)|#eaea5a|#be86ab|#e21d9f|rgb(234, 90, 185)",
    ),
  );
  assert.deepEqual(result.diagnostics, []);
});
test("invalid color component values fail visibly while later outputs still render", async () => {
  const source = `{{'#fff'|color_modify:'lightness',101}}|{{'#fff'|color_modify:'red',0.5}}|{{'#fff'|color_modify:'alpha',-1}}|After`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...base, "sections/main.liquid": source }),
    "/",
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 3);
  assert.ok(result.html.endsWith("After</div>"));
});
test("color brightness, contrast and lightness match documented reference values", async () => {
  const source = `{{'#EA5AB9'|color_brightness}}|{{'#E800B0'|color_contrast:'#D9D8FF'}}|{{'#000'|color_contrast:'#fff'}}|{{'#EA5AB9'|color_lighten:30}}|{{'#EA5AB9'|color_darken:30}}|{{'#334fb4'|color_extract:'lightness'}}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...base, "sections/main.liquid": source }),
    "/",
  );
  assert.ok(result.html.includes("143.89|3.0|21.0|#fbe2f3|#98136b|45"));
  assert.deepEqual(result.diagnostics, []);
});
test("float color results keep native numeric comparison and arithmetic behavior", async () => {
  const source = `{% assign ratio='#E800B0'|color_contrast:'#D9D8FF' %}{% if ratio==3 %}Equal{% endif %}|{% if ratio<4.5 %}Lower{% endif %}|{{ratio|times:2}}|{{'#ffffff'|color_darken:100}}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...base, "sections/main.liquid": source }),
    "/",
  );
  assert.ok(result.html.includes("Equal|Lower|6.0|#000000"));
  assert.deepEqual(result.diagnostics, []);
});
test("color filters accept typed theme colors and preserve alpha while rejecting bad percentages", async () => {
  const source = `{{settings.own|color_to_rgb}}|{{settings.own|color_extract:'alpha'}}|{{settings.own|color_lighten:10}}|{{'#fff'|color_darken:101}}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "config/settings_schema.json": JSON.stringify([
        { name: "Own", settings: [{ id: "own", type: "color", default: "rgba(20, 40, 60, 0.5)" }] },
      ]),
      "sections/main.liquid": source,
    }),
    "/",
  );
  assert.ok(result.html.includes("rgba(20, 40, 60, 0.5)|0.5|"));
  assert.ok(
    result.diagnostics.some((d) => d.code === "liquid-error" && d.message.includes("percentage")),
  );
});

test("hex conversion excludes alpha and lightness adjustment retains native rgba output", async () => {
  const source = `{{'rgba(234, 90, 185, 0.75)'|color_to_hex}}|{{'rgba(234, 90, 185, 0.75)'|color_darken:30}}`;
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...base, "sections/main.liquid": source }),
    "/",
  );
  assert.ok(result.html.includes("#ea5ab9|rgba(152, 19, 107, 0.75)"));
  assert.deepEqual(result.diagnostics, []);
});
