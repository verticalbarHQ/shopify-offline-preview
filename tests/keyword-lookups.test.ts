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
test("keyword roots become variable lookups only when followed by a dot or bracket", async () => {
  const html = await output(
    `{%assign blank='a,b'|split:','%}{{blank.first}}/{{blank.size}}|{%assign empty='x,y'|split:','%}{{empty[1]}}/{{empty.size}}`,
  );
  assert.ok(html.includes("a/2|y/2"), html);
});
test("boolean and nil keyword properties can access shadowing variables without changing standalone literals", async () => {
  const html = await output(
    `{%assign true='a,b'|split:','%}{%assign false='e,f'|split:','%}{%assign nil='c,d'|split:','%}{%assign null='g,h'|split:','%}{{true.first}}/{{true}}|{{false.last}}/{{false}}|{{nil.last}}/{{nil}}|{{null.last}}/{{null}}|{%if false%}wrong{%else%}literal{%endif%}|{%if true%}literal{%endif%}`,
  );
  assert.ok(html.includes("a/true|f/false|d/|h/|literal|literal"), html);
});
test("object keyword bindings support nested keys and filter arguments", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields.own = { payload: { foo: { bar: "found" }, key: "bar" } };
  const source = `{%assign blank=all_products['${product.handle}'].metafields.own.payload%}{{blank.foo[blank.key]}}|{{'prefix-'|append:blank.foo.bar}}`;
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/", { snapshot });
  assert.ok(result.html.includes("found|prefix-found"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("keyword lookups remain available in liquid statements and snippet named arguments", async () => {
  const input = {
    ...files(`{% liquid
assign blank='a,b'|split:','
echo blank.first
%}|{%render 'own',text:blank.last%}|{%include 'own',text:blank.first%}`),
    "snippets/own.liquid": "{{text}}",
  };
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/");
  assert.ok(result.html.includes("a|b|a"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("ordinary literals retain size and filter coercion and missing keyword variables stay missing", async () => {
  const html = await output(
    `{{'abc'.size}}|{{3.0|plus:2}}|{{blank.foo|default:'missing'}}|{%if ''==empty%}empty{%endif%}|{%if nil==nil%}nil{%endif%}`,
  );
  assert.ok(html.includes("3|5.0|missing|empty|nil"), html);
});
test("special literal equality is symmetric while ordinary numeric comparisons retain their behavior", async () => {
  const html = await output(
    `{% if nil == blank %}yes{% else %}no{% endif %}|{% if blank == nil %}yes{% else %}no{% endif %}|{% if false == blank %}yes{% else %}no{% endif %}|{% if empty == blank %}yes{% else %}no{% endif %}|{% if blank == empty %}yes{% else %}no{% endif %}|{% if nil == empty %}yes{% else %}no{% endif %}|{% if nil != blank %}wrong{% else %}equal{% endif %}|{% if empty != blank %}different{% endif %}|{% if 3.0 == 3 %}numeric{% endif %}`,
  );
  assert.ok(html.includes("yes|yes|yes|no|no|no|equal|different|numeric"), html);
});
test("keyword lookup output and diagnostics match between Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    `{%assign blank='a,b'|split:','%}{{blank.first}}|{{blank[1]}}|{%assign true=blank%}{{true.size}}/{{true}}|{%if nil == blank%}equal{%endif%}|{%if empty != blank%}different{%endif%}`,
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
