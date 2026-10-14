import assert from "node:assert/strict";
import { test } from "node:test";
import { Liquid } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { parseLiquid } from "../packages/render/src/parse-liquid.js";
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
test("quoted outputs and filter arguments preserve backslashes and Unicode escape text", async () => {
  const html = await output(
    String.raw`{{ 'a\q' | json }}|{{ "a\n" | json }}|{{ '\u0000' | json }}|{{ 'a\\b' | json }}|{{'a'|append:'\q'|json}}`,
  );
  assert.ok(html.includes(String.raw`"a\\q"|"a\\n"|"\\u0000"|"a\\\\b"|"a\\q"`), html);
});
test("assignments, comparisons, case branches and cycle candidates preserve literal values", async () => {
  const html = await output(
    String.raw`{% assign name='a\q' %}{% if name == 'a\q' %}same{% endif %}|{% case name %}{% when 'a\q' %}matched{% else %}wrong{% endcase %}|{% cycle 'a\q','x' %}|{% for i in (1..1) %}{{'\t'|json}}{% endfor %}`,
  );
  assert.ok(html.includes(String.raw`same|matched|a\q|"\\t"`), html);
});
test("backslashes do not escape matching quotes and opposite quotes remain literal", async () => {
  const html = await output(
    String.raw`{{ 'it\'s'|json }}|{{ "say \"yes\""|json }}|{{ "it's"|json }}`,
  );
  assert.ok(html.includes(String.raw`"it\\"|"say \\"|"it's"`), html);
});
test("quoted property keys preserve backslashes when reading snapshot JSON", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields.own = { "a\\q": "found" };
  const source =
    `{% assign values=all_products['${product.handle}'].metafields.own %}` +
    String.raw`{{values['a\q']}}`;
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/", { snapshot });
  assert.ok(result.html.includes("found"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("include and render named arguments retain literals without accessing dependency private fields", async () => {
  const input = {
    ...files(String.raw`{% include 'own', text:'a\q' %}|{% render 'own', text:'a\q' %}`),
    "snippets/own.liquid": "{{text|json}}",
  };
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/");
  assert.ok(result.html.includes(String.raw`"a\\q"|"a\\q"`), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("multiline liquid statements and dynamic settings retain backslash literals", async () => {
  const input = {
    ...files(String.raw`{% liquid
 assign text='a\q'
 echo text
%}|{{settings.own}}|{{settings.full}}`),
    "config/settings_schema.json":
      '[{"settings":[{"id":"own","type":"text"},{"id":"full","type":"text"}]}]',
    "config/settings_data.json": JSON.stringify({
      current: { own: String.raw`{{'a\q'}}`, full: String.raw`value={{'a\q'}}` },
    }),
  };
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/");
  assert.ok(result.html.includes(String.raw`a\q|a\q|value=a\q`), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("output auto escaping and original source positions survive tokenizer replacement", async () => {
  const engine = new Liquid({ outputEscape: "escape" });
  const source = String.raw`Before
{{ '<b>\q</b>' }}
{% assign text='x\q' %}
{{text}}`;
  const templates = parseLiquid(engine, source, "sections/own.liquid");
  const html = await engine.render(templates);
  assert.ok(html.includes(String.raw`&lt;b&gt;\q&lt;/b&gt;`), html);
  assert.ok(html.includes(String.raw`x\q`), html);
  const position = templates
    .find((t) => t.token.getText().startsWith("{{ '<b>"))
    ?.token.getPosition();
  assert.deepEqual(position, [2, 1]);
});
test("quoted literal behavior is identical between Node and browser with inspector metadata", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    String.raw`{%assign name='a\q'%}{{name|json}}|{%case name%}{%when 'a\q'%}match{%endcase%}|{%cycle 'a\q','x'%}`,
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
