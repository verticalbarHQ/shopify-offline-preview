import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function files(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  };
}
async function output(source: string) {
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/");
  assert.deepEqual(result.diagnostics, []);
  return result.html;
}
test("truncatewords preserves exact-boundary and short inputs including their whitespace", async () => {
  const html = await output(
    `{{'one two three'|truncatewords:3}}|{{'  one  two  '|truncatewords:3}}|{{'one two three four'|truncatewords:3}}|{{' \t '|truncatewords:1}}`,
  );
  assert.ok(html.includes("one two three|  one  two  |one two three...| \t "), html);
});
test("only ASCII whitespace splits words; nonbreaking spaces and Unicode content stay intact", async () => {
  const html = await output(
    `{{'a b c d'|truncatewords:2}}|{{'😀한 하나 둘'|truncatewords:2,'!'}}|{{'a\tb\nc d'|truncatewords:2}}`,
  );
  assert.ok(html.includes("a b c...|😀한 하나!|a b..."), html);
});
test("integer counts support bases, separators, signs and arbitrarily large limits", async () => {
  const html = await output(
    `{{'a b c d e f g h i j k l'|truncatewords:'0x2'}}|{{'a b c d e f g h i j k l'|truncatewords:'010'}}|{{'a b c d e f g h i j k l'|truncatewords:'1_0'}}|{{'a b c'|truncatewords:'+2'}}|{{'a b c'|truncatewords:' 2 '}}|{{'a b c'|truncatewords:0}}|{{'a b c'|truncatewords:-2}}|{{' a  b '|truncatewords:'999999999999999999999999999999'}}|{{' a  b '|truncatewords:999999999999999999999999999999}}`,
  );
  assert.ok(
    html.includes(
      "a b...|a b c d e f g h...|a b c d e f g h i j...|a b...|a b...|a...|a...| a  b | a  b ",
    ),
    html,
  );
});
test("omitted arguments use defaults while an explicit missing variable is nil", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      files(
        `{{'a b c d e f g h i j k l m n o p'|truncatewords}}|{{'a b c'|truncatewords:absent_count}}|{{'a b c'|truncatewords:2,absent_ending}}`,
      ),
    ),
    "/",
  );
  assert.ok(result.html.includes("a b c d e f g h i j k l m n o...|"), result.html);
  assert.ok(result.html.includes("invalid integer"), result.html);
  assert.ok(result.html.includes("|a b</div>"), result.html);
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});
test("invalid counts fail inline, including floats, nil, booleans and malformed integer strings", async () => {
  const source = `{{'a b c'|truncatewords:'2.9'}}|{{'a b c'|truncatewords:2.9}}|{{'a b c'|truncatewords:3.0}}|{{'a b c'|truncatewords:nil}}|{{'a b c'|truncatewords:true}}|{{'a b c'|truncatewords:'08'}}|{{'a b c'|truncatewords:'1__0'}}|After`;
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/");
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.equal(result.html.match(/invalid integer/g)?.length, 7);
  assert.ok(result.diagnostics.every((d) => d.message.includes("invalid integer")));
  assert.ok(result.html.includes("|After"));
});
test("nil input bypasses count coercion, custom nil endings are empty and arrays use inspection", async () => {
  const html = await output(
    `{{nil|truncatewords:3|json}}|{{nil|truncatewords:'bad'|json}}|{{'one two three four'|truncatewords:2,nil}}|{%assign arr='a b,c d'|split:','%}{{arr|truncatewords:2}}`,
  );
  assert.ok(html.includes('null|null|one two|["a b",...'), html);
});
test("array inspection preserves literal backslashes, interpolation text and control characters from snapshot data", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields.own = {
    hash: { title: "one two", enabled: false, empty: null, items: [1, "word"] },
    values: ["a\\u0000b", "#{test}", 'x"y', "z\\q"],
    controls: ["a\u0000b", "c\u0007d", "e\u000bf", "g\u001bh", "i\u007fj", "k\u0080l", "m\u2028n"],
  };
  const source = `{{all_products['${product.handle}'].metafields.own.values|truncatewords:100}}|{{all_products['${product.handle}'].metafields.own.controls|truncatewords:100}}|{{all_products['${product.handle}'].metafields.own.hash|truncatewords:100}}`;
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/", { snapshot });
  assert.ok(
    result.html.includes(String.raw`["a\\u0000b", "\#{test}", "x\"y", "z\\q"]`),
    result.html,
  );
  assert.ok(
    result.html.includes(
      String.raw`["a\u0000b", "c\ad", "e\vf", "g\eh", "i\u007Fj", "k\u0080l", "m\u2028n"]`,
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(
    result.html.includes(
      '{"title"=>"one two", "enabled"=>false, "empty"=>nil, "items"=>[1, "word"]}',
    ),
    result.html,
  );
});
test("truncatewords rendering and diagnostics are identical between Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    `{{'  a b  '|truncatewords:2}}|{{'a b c d'|truncatewords:2}}|{{'a b c'|truncatewords:2.9}}|{{nil|truncatewords:2|json}}`,
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
