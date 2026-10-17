import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  };
}
test("empty replacement patterns insert at Unicode character boundaries including both ends", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      theme(
        `{{'hi'|replace:'','x'}}|{{'😀한'|replace:'','x'}}|{{''|replace:'','x'}}|{{'abc'|replace:'',''}}|{{'aba'|replace:'a','$&'}}`,
      ),
    ),
    "/",
  );
  assert.ok(result.html.includes("xhxix|x😀x한x|x|abc|$&b$&"));
  assert.deepEqual(result.diagnostics, []);
});
test("string filters read an array in Ruby notation and escape as Shopify does", async () => {
  // Each expression and the output Shopify rendered for it on a development store (2026-10-17).
  const cases: [string, string][] = [
    ["a | append: '!'", '["a", "b"]!'],
    ["a | prepend: '!'", '!["a", "b"]'],
    ["a | upcase", '["A", "B"]'],
    ["a | replace: 'a', 'x'", '["x", "b"]'],
    ["a | escape", "[&quot;a&quot;, &quot;b&quot;]"],
    ["'a\"b' | escape", "a&quot;b"],
    ['"it\'s > <" | escape', "it&#39;s &gt; &lt;"],
    [
      "'&quot; &nbsp; &#39; &#x27; \" < & &AMP; &#123;' | escape_once",
      "&quot; &nbsp; &#39; &amp;#x27; &quot; &lt; &amp; &AMP; &#123;",
    ],
    ["a | strip", '["a", "b"]'],
    ["a | split: '\"' | size", "5"],
    ["e | append: '!'", "[]!"],
    ["a | url_encode", "%5B%22a%22%2C+%22b%22%5D"],
    ["a | truncate: 6", '["a...'],
    ["a | append: '' | size", "10"],
  ];
  const loop =
    "{% liquid\nassign p = null\nfor i in (1..4)\n  assign p = p | append: ', '\n  assign p = p | split: ','\n  echo p.size | append: ';'\nendfor\n%}";
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      theme(
        `{%- assign a = 'a,b' | split: ',' -%}{%- assign e = '' | split: ',' -%}${cases
          .map(([expression]) => `<p>{{ ${expression} }}</p>`)
          .join("")}<p>${loop}</p>`,
      ),
    ),
    "/",
  );
  const actual = [...result.html.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => m[1]);
  assert.deepEqual(actual, [...cases.map(([, expected]) => expected), "2;3;4;5;"]);
});
test("contains never matches nil or false while retaining ordinary string and array membership", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields.own = { values: [1, null, 3, false, ""] };
  const source = `{% assign values=all_products['${product.handle}'].metafields.own.values %}{% if values contains nil %}wrong{% else %}no{% endif %}|{% if 'abc' contains nil %}wrong{% else %}no{% endif %}|{% if values contains 3 %}yes{% endif %}|{% if values contains false %}wrong{% else %}no{% endif %}|{% if values contains '' %}yes{% endif %}|{% if 'abc' contains '' %}yes{% endif %}`;
  const result = await renderTheme(new MemoryThemeFileSystem(theme(source)), "/", { snapshot });
  assert.ok(result.html.includes("no|no|yes|no|yes|yes"));
  assert.deepEqual(result.diagnostics, []);
});
test("core string and membership behavior is identical in the Node and browser builds", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const files = theme(
    `{{'😀한'|replace:'','x'}}|{% if 'abc' contains nil %}wrong{% else %}no{% endif %}|{% if 'false' contains false %}wrong{% else %}no{% endif %}|{{'aba'|replace:'a','$&'}}`,
  );
  const options = { snapshot: defaultFixture(), inspect: true };
  assert.equal(
    JSON.stringify(
      await browser.renderTheme(new browser.MemoryThemeFileSystem(files), "/", options),
    ),
    JSON.stringify(await renderTheme(new MemoryThemeFileSystem(files), "/", options)),
  );
});
