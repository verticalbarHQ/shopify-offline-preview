import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

async function render(source: string, path = "/") {
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "templates/product.json":
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  });
  return renderTheme(theme, path, { snapshot: defaultFixture() });
}

// Each expression and the output Shopify rendered for it on a development store (2026-10-17).
// Liquid errors are compared without their file and line.
const measured: [string, string][] = [
  ["'#7ab55c' | color_desaturate: 30", "#869180"],
  ["'#ea5ab9' | color_desaturate: 0", "#ea5ab9"],
  ["'rgb(100, 50, 200)' | color_desaturate: 50", "rgb(121, 113, 138)"],
  ["'#7ab55c' | color_saturate: 30", "#6ed938"],
  ["'#808080' | color_saturate: 40", "#b34d4d"],
  ["'rgba(234, 90, 185, 0.5)' | color_saturate: 10", "rgba(243, 81, 188, 0.5)"],
  ["'#7ab55c' | color_mix: '#ffffff', 50", "#bddaae"],
  ["'rgba(234, 90, 185, 0.5)' | color_mix: '#000000', 25", "rgba(59, 23, 46, 0.88)"],
  ["'#ff0000' | color_mix: '#0000ff', 33", "#5400ab"],
  ["'#7ab55c' | color_to_hsl", "hsl(100, 38%, 54%)"],
  ["'rgba(234, 90, 185, 0.5)' | color_to_hsl", "hsla(320, 77%, 64%, 0.5)"],
  ["'#000000' | color_to_hsl", "hsl(0, 0%, 0%)"],
  ["'#7ab55c' | color_to_oklch", "oklch(71% 0.14 136 / 1.0)"],
  ["'rgba(234, 90, 185, 0.5)' | color_to_oklch", "oklch(68% 0.2 343 / 0.5)"],
  ["'#ffffff' | color_to_oklch", "oklch(100% 0.0 90 / 1.0)"],
  ["'#000000' | color_to_oklch", "oklch(0% 0.0 0 / 1.0)"],
  ["'#0000ff' | color_to_oklch", "oklch(45% 0.31 264 / 1.0)"],
  ["'#7ab55c' | hex_to_rgba", "rgba(122,181,92,1)"],
  ["'#7ab55c' | hex_to_rgba: 0.5", "rgba(122,181,92,0.5)"],
  ["'#abc' | hex_to_rgba", "rgba(170,187,204,1)"],
  ["'7ab55c' | hex_to_rgba: 1", "7ab55c"],
  ["'#7ab55c' | brightness_difference: '#ffffff'", "102"],
  ["'#000000' | brightness_difference: '#ffffff'", "255"],
  ["'rgb(10, 20, 30)' | brightness_difference: '#ea5ab9'", "126"],
  ["'#7ab55c' | color_difference: '#ffffff'", "370"],
  ["'#000000' | color_difference: '#ffffff'", "765"],
  ["'rgb(10, 20, 30)' | color_difference: '#ea5ab9'", "449"],
  ["'hello' | sha1", "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"],
  ["'' | sha1", "da39a3ee5e6b4b0d3255bfef95601890afd80709"],
  ["'\u00dcn\u00efcode \u2713' | sha1", "3df3fa389458ae341902c17ccf5c8d18e4cfbbd9"],
  ["'hello' | hmac_sha1: 'secret'", "5112055c05f944f85755efc5cd8970e194e9f45b"],
  [
    "'\u00dcn\u00efcode \u2713' | hmac_sha1: 'k\u00e9y'",
    "b09874b898f9bb15d70afa511d84a2bbfa756806",
  ],
  ["'hello' | blake3", "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f"],
  ["'' | blake3", "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"],
  [
    "'\u00dcn\u00efcode \u2713' | blake3",
    "c0eedc88c89e7e23642c816e411bc1da176ae938669d7871089e8106344e1eee",
  ],
  ["'one two three?' | base64_url_safe_encode", "b25lIHR3byB0aHJlZT8="],
  ["'>>>???' | base64_url_safe_encode", "Pj4-Pz8_"],
  ["'Pj4-Pz8_' | base64_url_safe_decode", ">>>???"],
  ["'b25lIHR3byB0aHJlZT8' | base64_url_safe_decode", "one two three?"],
  ["'variable-name' | camelize", "VariableName"],
  ["'variable_name here' | camelize", "VariableNameHere"],
  ["'already CamelCase' | camelize", "AlreadyCamelcase"],
  ["'x--y__z' | camelize", "XYZ"],
  ["'<p>Health & Love potions</p>' | url_escape", "%3Cp%3EHealth%20&%20Love%20potions%3C/p%3E"],
  [
    "'a b/c?d=e&f#g+h%i;j,k:l@m$n!o*p(q)r~s' | url_escape",
    "a%20b/c?d=e&f%23g+h%25i;j,k:l@m$n!o*p(q)r~s",
  ],
  ["'\u00dcn\u00ef \u2713' | url_escape", "%C3%9Cn%C3%AF%20%E2%9C%93"],
  [
    "'<p>Health & Love potions</p>' | url_param_escape",
    "%3Cp%3EHealth%20%26%20Love%20potions%3C/p%3E",
  ],
  [
    "'a b/c?d=e&f#g+h%i;j,k:l@m$n!o*p(q)r~s' | url_param_escape",
    "a%20b/c?d=e%26f%23g+h%25i;j,k:l@m$n!o*p(q)r~s",
  ],
  ["'\u00dcn\u00ef \u2713' | url_param_escape", "%C3%9Cn%C3%AF%20%E2%9C%93"],
  [
    "'The Matrix Needle matrix' | highlight: 'matrix'",
    'The <strong class="highlight">Matrix</strong> Needle <strong class="highlight">matrix</strong>',
  ],
  [
    "'<p>Matrix &amp; needle</p>' | highlight: 'needle'",
    '<p>Matrix &amp; <strong class="highlight">needle</strong></p>',
  ],
  ["'abc' | highlight: ''", "abc"],
  ["'a.b a*b' | highlight: 'a.b'", '<strong class="highlight">a.b</strong> a*b'],
  [
    "'<p class=\"p\">pop</p>' | highlight: 'p'",
    '<<strong class="highlight">p</strong> class="<strong class="highlight">p</strong>"><strong class="highlight">p</strong>o<strong class="highlight">p</strong></<strong class="highlight">p</strong>>',
  ],
  ["'Fish &amp; chips' | highlight: 'amp'", 'Fish &<strong class="highlight">amp</strong>; chips'],
  ["'matrix needle thread' | highlight: 'matrix thread'", "matrix needle thread"],
  ["'MATRIX' | highlight: 'matrix'", '<strong class="highlight">MATRIX</strong>'],
  ["nil | highlight: 'a'", ""],
  ["'#abc' | color_saturate: 20", "#9cbbda"],
  ["'#abc' | color_mix: '#fff', 50", "#d5dde6"],
  ["'#7ab55c' | color_mix: 'rgba(0, 0, 0, 0.5)', 50", "rgba(61, 91, 46, 0.75)"],
  [
    "'#7ab55c' | color_desaturate: 200",
    "Liquid error: Desaturate amount must be a numeric value between 0 and 100",
  ],
  ["'#7ab55c' | color_to_hsl | color_saturate: 10", "hsl(100, 48%, 54%)"],
  ["'hsl(100, 38%, 54%)' | color_to_hsl", "hsl(100, 38%, 54%)"],
  ["'oklch(71% 0.14 136 / 1.0)' | hex_to_rgba", "oklch(71% 0.14 136 / 1.0)"],
  ["'#7ab55c' | hex_to_rgba: 0.25 | color_saturate: 5", "rgba(120, 187, 86, 0.25)"],
  ["'#808080' | color_desaturate: 10", "#808080"],
  ["'#7ab55c80' | color_desaturate: 10", "rgba(126, 169, 104, 0.5)"],
  ["'#ff0000' | color_to_oklch", "oklch(63% 0.26 29 / 1.0)"],
  ["'#00ff00' | color_to_oklch", "oklch(87% 0.29 142 / 1.0)"],
  ["'#123456' | color_to_oklch", "oklch(32% 0.07 251 / 1.0)"],
  ["'#fedcba' | color_to_oklch", "oklch(91% 0.06 67 / 1.0)"],
  ["'rgba(18, 52, 86, 0.333)' | color_to_oklch", "oklch(32% 0.07 251 / 0.33)"],
  ["'#123456' | color_to_hsl", "hsl(210, 65%, 20%)"],
  ["'#fedcba' | color_saturate: 33", "#ffdcb9"],
  ["'One two' | camelize", "OneTwo"],
  ["'a1b c2d' | camelize", "A1bC2d"],
  ["'\u00dcBER \u00fcber' | camelize", "UberUber"],
  ['"it\'s [x]" | url_escape', "it's%20[x]"],
  [
    "'abc==' | base64_url_safe_decode",
    "Liquid error: invalid base64 provided to base64_url_safe_decode",
  ],
];

test("color, hash, encoding and text filters match Shopify's output", async () => {
  const { html } = await render(
    measured.map(([expression]) => `<pre>{{ ${expression} }}</pre>`).join(""),
  );
  const actual = [...html.matchAll(/<pre>(.*?)<\/pre>/gs)].map((m) =>
    m[1]?.replace(/^Liquid error \([^)]*\): /, "Liquid error: "),
  );
  assert.deepEqual(
    actual,
    measured.map(([, expected]) => expected),
  );
});

test("script_tag and stylesheet_tag write extra attributes in the order given", async () => {
  const { html } = await render(
    "<p>{{ '/a.js' | script_tag: type: 'module', defer: true }}</p>" +
      "<p>{{ '/a.js' | script_tag: async: true, defer: false, data-x: 'y' }}</p>" +
      "<p>{{ '/a.css' | stylesheet_tag: media: 'print', preload: true }}</p>" +
      "<p>{{ '/a.css' | stylesheet_tag: crossorigin: 'anonymous', disabled: true, fetchpriority: 'high' }}</p>",
  );
  assert.deepEqual(
    [...html.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => m[1]),
    [
      '<script src="/a.js" type="module" defer="defer"></script>',
      '<script src="/a.js" type="text/javascript" async="async" data-x="y"></script>',
      '<link href="/a.css" rel="stylesheet" type="text/css" media="print" />',
      '<link href="/a.css" rel="stylesheet" type="text/css" media="all" crossorigin="anonymous" disabled="disabled" fetchpriority="high" />',
    ],
  );
});

test("collections list their products' tags, types and vendors", async () => {
  const { html } = await render(
    "<p>{% assign c = collections['sop-catalog'] %}{{ c.all_tags | join: ',' }}|{{ c.all_types | join: ',' }}|{{ c.all_vendors | join: ',' }}</p>",
  );
  assert.ok(html.includes("<p>blue,red,sop-fixture|Test Goods|Example Studio</p>"), html);
});

test("date formats, image quality, unit prices and font URLs fail or stay empty as on Shopify", async () => {
  const { html } = await render(
    "<p>{{ product.created_at | date: format: 'month_day_year' }}</p>" +
      "<p>{{ product | image_url: width: 450, quality: 80 }}</p>" +
      "<p>[{{ product.selected_or_first_available_variant.unit_price | unit_price_with_measurement: nil }}]</p>" +
      "<p>{{ settings.missing_font | font_url }}</p>",
    "/products/sop-matrix-needle",
  );
  assert.deepEqual(
    [...html.matchAll(/<p>(.*?)<\/p>/gs)].map((m) =>
      // The preview escapes error text; a browser shows it as Shopify's.
      m[1]?.replace(/^Liquid error \([^)]*\): /, "").replaceAll("&#39;", "'"),
    ),
    [
      "The format option 'month_day_year' is not a supported format.",
      "quality can't be used with ext png",
      "[]",
      "font_url can only be used with a font drop",
    ],
  );
});
