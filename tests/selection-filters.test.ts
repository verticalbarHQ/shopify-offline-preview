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
async function output(source: string, expected: string) {
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/");
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes(expected), result.html);
}
test("selection on strings searches literal fragments instead of string properties", async () => {
  await output(
    "{%assign words='a,b,a'|split:','%}{{words|where:'a'|join:','}}|{{words|where:'a',true|json}}|{{words|where:'size',1|json}}|{{words|where:'a','a'|json}}|{{words|where:''|json}}",
    'a,a|[]|[]|["a","a"]|["a","b","a"]',
  );
});
test("find, find_index, has and reject preserve source order and default result types", async () => {
  await output(
    "{%assign words='a,b,a'|split:','%}{{words|find:'a'|json}}|{{words|find_index:'a'|json}}|{{words|has:'a'|json}}|{{words|reject:'a'|json}}|{{words|find:'missing'|json}}|{{words|find_index:'missing'|json}}|{{words|has:'missing'|json}}",
    '"a"|0|true|["b"]|null|null|false',
  );
});
test("explicit nil targets retain presence selection and avoid matching nil fields", async () => {
  await output(
    "{%assign words='a,b,a'|split:','%}{{words|where:'a',nil|json}}|{{words|reject:'a',nil|json}}",
    '["a","a"]|["b"]',
  );
});
test("selection accepts string character offsets and ranges, including float coercion", async () => {
  await output(
    "{{'abc'|where:1|json}}|{{'abc'|where:1.7|json}}|{{'abc'|where:(0..1)|json}}|{{'abc'|where:-1,'c'|json}}",
    '["abc"]|["abc"]|["abc"]|["abc"]',
  );
  await output("{{'가😀나'|where:1,'😀'|json}}", '["가😀나"]');
});
test("integer bit properties preserve Liquid truthiness and safe negative offsets", async () => {
  await output(
    "{{(1..3)|where:1|json}}|{{(1..3)|where:1.7|json}}|{{(1..3)|where:(0..1),2|json}}|{{(1..3)|where:(1..2),1|json}}|{{(1..3)|where:(-1..1),6|json}}|{{(1..3)|where:(3..1)|json}}|{{(1..3)|where:-1,0|json}}|{{(1..3)|where:(-1000000000..-1000000000),0|json}}",
    "[1,2,3]|[1,2,3]|[2]|[2,3]|[3]|[1,2,3]|[1,2,3]|[1,2,3]",
  );
});
test("nonindexable items return nil while empty inputs keep each filter's default", async () => {
  await output(
    "{{false|where:'title'|json}}|{{nil|where:'title'|json}}|{{nil|reject:'title'|json}}|{{nil|find:'title'|json}}|{{nil|find_index:'title'|json}}|{{nil|has:'title'|json}}",
    "null|[]|[]|null|null|false",
  );
});
test("invalid scalar properties report errors while subsequent output continues", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(files("{{(1..3)|where:'size'|json}}|{{'abc'|where:nil|json}}|After")),
    "/",
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 2);
  assert.ok(result.diagnostics.some((d) => d.message === "cannot select the property 'size'"));
  assert.ok(result.diagnostics.some((d) => d.message === "cannot select the property ''"));
  assert.ok(result.html.includes("|After"));
});
test("nested arrays flatten, literal dotted keys resolve and missing fields do not read globals", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0];
  assert.ok(product);
  product.metafields.own = {
    payload: {
      items: [[{ "a.b": true, available: false }], [{ available: true }, { title: "missing" }]],
      words: ["available", "absent"],
    },
  };
  const source = `{%assign env=all_products['${product.handle}'].metafields.own.payload%}{%assign title=true%}{{env.items|where:'a.b'|size}}|{{env.items|where:'available'|size}}|{{env.items|where:'title'|size}}|{{env.words|where:'title'|json}}`;
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/", { snapshot });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes("1|1|1|[]"), result.html);
});
test("a string accumulator finds duplicates through primitive selection", async () => {
  await output(
    "{%assign words='apple banana apple cherry'|split:' '%}{%assign seen='' %}{%for word in words%}{%assign matches=seen|split:','|where:word%}{%if matches.size==0%}{%if seen!=''%}{%assign seen=seen|append:','%}{%endif%}{%assign seen=seen|append:word%}{%endif%}{%endfor%}{{seen}}",
    "apple,banana,cherry",
  );
});
test("selection results and inspector metadata match in Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    "{%assign words='a,b,a'|split:','%}{{words|where:'a'|json}}|{{words|reject:'a'|json}}|{{words|find_index:'a'|json}}|{{(1..3)|where:(0..1),2|json}}",
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
