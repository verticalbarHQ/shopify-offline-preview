import assert from "node:assert/strict";
import { test } from "node:test";
import { Font, fontSetting } from "../packages/render/src/fonts.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("saved system font handles retain their metadata without a download", async () => {
  const missing: string[] = [];
  for (const [handle, family, weight, style] of [
    ["sans_serif_n7", "Helvetica", 700, "normal"],
    ["arial_i4", "Arial", 400, "italic"],
    ["courier_new_i7", '"Courier New"', 700, "italic"],
    ["mono", '"SF Mono"', 400, "normal"],
    ["serif", '"New York"', 400, "normal"],
    ["sans-serif", "-apple-system", 400, "normal"],
    ["system_ui_n4", "system_ui", 400, "normal"],
  ] as const) {
    const font = fontSetting(handle, (message) => missing.push(message));
    assert.ok(font);
    assert.equal(font.family, family);
    assert.equal(font.weight, weight);
    assert.equal(font.style, style);
    assert.equal(font["system?"], true);
    assert.equal(font.valueOf(), handle);
    assert.equal(font.url(), "");
  }
  assert.deepEqual(missing, []);
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": '{"sections":{},"order":[]}',
      "layout/theme.liquid":
        "{{settings.body.family}}|{{settings.body.weight}}|{{settings.body.style}}|{{settings.body.system?}}|{{settings.body | font_face}}|{{settings.body | font_url}}",
      "config/settings_schema.json": JSON.stringify([
        { settings: [{ type: "font_picker", id: "body", default: "arial_n4" }] },
      ]),
      "config/settings_data.json": '{"current":{"body":"sans_serif_i7"}}',
    }),
    "/",
  );
  assert.equal(result.html, "Helvetica|700|italic|true||");
  assert.deepEqual(result.diagnostics, []);
});

test("captured deprecated Helvetica settings preserve metadata and diagnose absent files instead of changing font", async () => {
  const missing: string[] = [];
  const font = fontSetting("helvetica_n4", (message) => missing.push(message));
  assert.ok(font);
  assert.equal(font.family, "Helvetica");
  assert.equal(font.fallback_families, "'Helvetica Neue', Arial, 'Lucida Grande', sans-serif");
  assert.equal(font["system?"], false);
  assert.equal(font.modify("weight", "bold")?.valueOf(), "helvetica_n7");
  assert.equal(font.modify("style", "oblique")?.valueOf(), "helvetica_o4");
  assert.equal(font.modify("style", "italic"), null);
  assert.equal(font.modify("weight", "300")?.fallback_families, "sans-serif");
  assert.equal(font.modify("weight", "500"), null);
  assert.equal(font.variants.length, 8);
  assert.deepEqual(missing, []);
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": '{"sections":{},"order":[]}',
      "layout/theme.liquid":
        "{{settings.body.family}}|{{settings.body.weight}}|{{settings.body.style}}|{{settings.body.system?}}|{{settings.body | font_face}}|{{settings.body | font_url}}",
      "config/settings_schema.json": JSON.stringify([
        { settings: [{ type: "font_picker", id: "body", default: "arial_n4" }] },
      ]),
      "config/settings_data.json": '{"current":{"body":"helvetica_o7"}}',
    }),
    "/",
  );
  assert.equal(result.html, "Helvetica|700|oblique|false||");
  assert.ok(result.diagnostics.length > 0);
  assert.ok(
    result.diagnostics.every(
      (d) =>
        d.code === "missing-resource" &&
        d.message.includes("helvetica_o7") &&
        d.file === "layout/theme.liquid",
    ),
  );
});

test("mapped font families expose CSS-safe names, weights, styles and actual available variants", () => {
  const missing: string[] = [];
  const font = fontSetting("work_sans_n5", (message) => missing.push(message));
  assert.ok(font instanceof Font);
  assert.equal(font.family, '"Work Sans"');
  assert.equal(font.fallback_families, "sans-serif");
  assert.equal(font["system?"], false);
  assert.equal(font.weight, 500);
  assert.equal(font.variants.length, 18);
  assert.equal(font.modify("weight", "bold")?.weight, 700);
  assert.equal(font.modify("weight", "+200")?.weight, 700);
  assert.equal(font.modify("weight", "-400")?.weight, 100);
  assert.equal(font.modify("weight", "bolder")?.weight, 700);
  assert.equal(font.modify("weight", "lighter")?.weight, 100);
  assert.equal(font.modify("style", "italic")?.style, "italic");
  assert.equal(font.modify("style", "oblique"), null);
  const assistant = fontSetting("assistant_n4", (message) => missing.push(message));
  assert.equal(assistant?.variants.length, 7);
  assert.equal(assistant?.modify("style", "italic"), null);
  const mono = fontSetting("anonymous_pro_i4", (message) => missing.push(message));
  assert.equal(mono?.variants.length, 4);
  assert.equal(mono?.modify("weight", "+100"), null);
  assert.deepEqual(missing, []);
});

test("font filters produce deterministic CSS/URLs and explicit CDN substitutions without network access", async () => {
  const schema = [
    {
      name: "Own fonts",
      settings: [
        { type: "font_picker", id: "body", default: "work_sans_n4" },
        { type: "font_picker", id: "heading", default: "assistant_n4" },
        { type: "font_picker", id: "dynamic", default: "{{settings.body}}" },
      ],
    },
  ];
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "config/settings_schema.json": JSON.stringify(schema),
    "sections/main.liquid":
      "<style>{{settings.body | font_face: font_display: 'swap'}}</style>|{{settings.body | font_url}}|{% assign bold = settings.body | font_modify: 'weight', 'bold' %}{{bold.weight}}|{% assign italic = settings.heading | font_modify: 'style', 'italic' %}{% if italic == nil %}nil{% endif %}|{{settings.dynamic.family}}|{{nil | font_face}}|{{settings.body | font_url: format: 'woff'}}",
  });
  const result = await renderTheme(theme, "/");
  assert.match(
    result.html,
    /font-family: "Work Sans";\n {2}font-weight: 400;\n {2}font-style: normal;\n {2}font-display: swap;/,
  );
  assert.match(result.html, /https:\/\/fonts\.gstatic\.com\/s\/worksans\/.*\.woff2/);
  assert.match(result.html, /\|700\|nil\|"Work Sans"\|\|/);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(
    result.diagnostics.every((d) => d.code === "shopify-server-only" && d.severity === "info"),
  );
  assert.ok(result.diagnostics.every((d) => d.file === "sections/main.liquid"));
  assert.deepEqual(await renderTheme(theme, "/"), result);
});

test("unmapped fonts, missing metadata and unsafe CSS options stay visible", async () => {
  const missing: string[] = [];
  for (const handle of [
    "unknown_n4",
    "constructor_n4",
    "assistant_i4",
    "assistant_n9",
    "x</style>_n4",
  ])
    assert.equal(
      fontSetting(handle, (message) => missing.push(message)),
      null,
    );
  assert.equal(missing.length, 5);
  const font = fontSetting("assistant_n4", (message) => missing.push(message));
  assert.equal(font?.liquidMethodMissing("baseline_ratio"), undefined);
  assert.equal(missing.length, 6);
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "config/settings_schema.json": JSON.stringify([
        { settings: [{ type: "font_picker", id: "body", default: "assistant_n4" }] },
      ]),
      "sections/main.liquid": "{{settings.body | font_face: font_display: 'swap;}</style>'}}",
    }),
    "/",
  );
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.ok(!result.html.includes("font-display: swap;}"));
});

test("configured Inter overrides support font URL preloads without introducing Liquid errors", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid": "{{content_for_layout}}",
      "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "config/settings_schema.json": JSON.stringify([
        { settings: [{ type: "font_picker", id: "body", default: "work_sans_n4" }] },
      ]),
      "config/settings_data.json": '{"current":{"body":"inter_n7"}}',
      "sections/main.liquid":
        "{% unless settings.body.system? %}{{settings.body | font_url | preload_tag: as: 'font', type: 'font/woff2'}}{% endunless %}|{{settings.body.family}}:{{settings.body.weight}}",
    }),
    "/",
  );
  assert.match(result.html, /href="https:\/\/fonts\.gstatic\.com\/s\/inter\/.*\.woff2"/);
  assert.ok(result.html.includes("Inter:700"));
  assert.ok(result.diagnostics.every((d) => d.code === "shopify-server-only"));
});
