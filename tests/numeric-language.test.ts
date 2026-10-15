import assert from "node:assert/strict";
import { test } from "node:test";
import { Liquid } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { registerJsonFilter } from "../packages/render/src/filters/json.js";
import { renderTheme } from "../packages/render/src/index.js";
import { LiquidFloat } from "../packages/render/src/numbers.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function files(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  };
}
async function render(source: string) {
  return renderTheme(new MemoryThemeFileSystem(files(source)), "/", { inspect: true });
}

test("integer division floors while either float operand preserves fractional results", async () => {
  const result = await render(
    `{{ 5 | divided_by:3 }}|{{ -5 | divided_by:3 }}|{{ 5.0 | divided_by:3 }}|{{ 5 | divided_by:3.0 }}|{{ 5 | divided_by:'3.0' }}|{{ 5 | divided_by:'3' }}`,
  );
  assert.ok(
    result.html.includes("1|-2|1.6666666666666667|1.6666666666666667|1.6666666666666667|1"),
  );
  assert.deepEqual(result.diagnostics, []);
});
test("float literals survive assignments, nested branches and loops and maintain numeric comparisons", async () => {
  const result = await render(
    `{% assign n=3.0 %}{{n}}|{{n|plus:2}}|{%if n==3%}equal{%endif%}|{%if n>2 and n<4%}ordered{%endif%}|{%for i in(1..2)%}{%if i>0%}{{3.000}}{%endif%}{%endfor%}|{{ -0.0 }}`,
  );
  assert.ok(result.html.includes("3.0|5.0|equal|ordered|3.03.0|-0.0"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("style bodies preserve decimal literals through liquid blocks and nested loops", async () => {
  const result = await render(`{% style %}{% liquid
    assign sizes = '14,14,12,24' | split: ','
    for size in sizes
      assign rem = size | divided_by: 16.0
      echo '--size:' | append: rem | append: 'rem;'
    endfor
  %}{% endstyle %}`);
  assert.ok(
    result.html.includes(
      "<style data-shopify>--size:0.875rem;--size:0.875rem;--size:0.75rem;--size:1.5rem;</style>",
    ),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});
test("arithmetic coercion distinguishes complete decimal strings from integer-prefix strings", async () => {
  const result = await render(
    `{{'3abc'|plus:2}}|{{'3.5abc'|plus:2}}|{{'2e1'|plus:0}}|{{'1.2.3'|plus:0}}|{{'abc'|plus:2}}|{{'3.0'|plus:2}}|{{3.0|times:2}}|{{3.0|abs}}|{{3.0|modulo:2}}|{{3.0|round}}`,
  );
  assert.ok(result.html.includes("5|5|2|1|2|5.0|6.0|3.0|1.0|3"));
  assert.deepEqual(result.diagnostics, []);
});
test("integer zero division is inline error but float zero division produces Infinity", async () => {
  const result = await render(`{{5|divided_by:0}}|{{5.0|divided_by:0}}|{{5|divided_by:0.0}}`);
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
  assert.ok(result.html.includes("|Infinity|Infinity"));
});
test("decimal arithmetic avoids binary floating errors and preserves the divisor sign for modulo", async () => {
  const result = await render(
    `{{0.1|plus:0.2}}|{{0.1|minus:0.3}}|{{0.1|times:3}}|{{0.1|divided_by:3}}|{{0.3|divided_by:0.1}}|{{0.1|modulo:0.3}}|{{ -0.1 |modulo:0.3}}|{{0.1|modulo:-0.3}}|{{'.5'|plus:2}}|{{'3.'|plus:2}}`,
  );
  assert.ok(
    result.html.includes("0.3|-0.2|0.3|0.03333333333333333|3.0|0.1|0.2|-0.2|2|5"),
    result.html,
  );
  assert.deepEqual(result.diagnostics, []);
});
test("JSON retains float number lexemes without quoting them or changing integer values", async () => {
  const result = await render(`{{3.0|json}}|{{3|json}}|{{ -0.0 |json}}|{{'3.0'|plus:2|json}}`);
  assert.ok(result.html.includes("3.0|3|-0.0|5.0"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("JSON preserves nested float numbers, numeric object keys and script escaping", async () => {
  const engine = new Liquid();
  registerJsonFilter(engine);
  const input = {
    "0": new LiquidFloat(3),
    nested: [new LiquidFloat(-0), { value: new LiquidFloat(5), text: "</script>" }],
    integer: 3,
  };
  const output = await engine.parseAndRender("{{input|json}}", { input });
  assert.equal(
    output,
    '{"0":3.0,"nested":[-0.0,{"value":5.0,"text":"\\u003c\\/script\\u003e"}],"integer":3}',
  );
  assert.deepEqual(JSON.parse(output), {
    "0": 3,
    nested: [-0, { value: 5, text: "</script>" }],
    integer: 3,
  });
});
test("color floats retain numeric type through arithmetic, JSON and component arguments", async () => {
  const result = await render(
    `{%assign ratio='#E800B0'|color_contrast:'#D9D8FF'%}{{ratio|times:2}}|{{ratio|json}}|{{'#EA5AB9'|color_modify:'alpha',0.85}}|{{'#fff'|color_modify:'red',3.0}}|{{5.0|modulo:0}}`,
  );
  assert.ok(result.html.includes("6.0|3.0|rgba(234, 90, 185, 0.85)|#03ffff|"), result.html);
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});
test("render arguments and dynamic settings retain literal float identity", async () => {
  const source = `{%render 'numeric',number:3.0%}|{{settings.own_number|plus:2}}|{{settings.own_text}}`;
  const input = {
    ...files(source),
    "snippets/numeric.liquid": "{{number}}|{{number|divided_by:2}}",
    "config/settings_schema.json":
      '[{"settings":[{"id":"own_number","type":"text"},{"id":"own_text","type":"text"}]}]',
    "config/settings_data.json": JSON.stringify({
      current: { own_number: "{{3.0}}", own_text: "value={{3.0}}" },
    }),
  };
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/");
  assert.ok(result.html.includes("3.0|1.5|5.0|value=3.0"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("float parsing, arithmetic and JSON are identical between Node and browser bundles", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    `{%assign n=3.0%}{{n|divided_by:2}}|{{n|json}}|{{5|divided_by:3}}|{%for i in(1..2)%}{{3.0}}{%endfor%}`,
  );
  const options = { snapshot: defaultFixture(), inspect: true };
  assert.equal(
    JSON.stringify(
      await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    ),
    JSON.stringify(await renderTheme(new MemoryThemeFileSystem(input), "/", options)),
  );
});
