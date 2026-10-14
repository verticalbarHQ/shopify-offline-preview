import assert from "node:assert/strict";
import { test } from "node:test";
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
test("nested loops expose parent metadata and restore the outer loop after an inner loop", async () => {
  const html = await output(
    `{% for row in (1..2) %}{% for column in (1..2) %}{{forloop.parentloop.index}}.{{forloop.index}};{% endfor %}outer={{forloop.index}};{% if forloop.parentloop == nil %}root;{% endif %}{% endfor %}`,
  );
  assert.ok(html.includes("1.1;1.2;outer=1;root;2.1;2.2;outer=2;root;"), html);
});
test("three-level parent chains retain first, last, length and reverse indices", async () => {
  const html = await output(
    `{% for row in (1..2) %}{% for column in (1..1) %}{% for cell in (1..1) %}{{forloop.parentloop.parentloop.index0}}/{{forloop.parentloop.parentloop.rindex}}/{{forloop.parentloop.parentloop.length}}/{{forloop.parentloop.parentloop.first}}/{{forloop.parentloop.parentloop.last}};{% endfor %}{% endfor %}{% endfor %}`,
  );
  assert.ok(html.includes("0/2/2/true/false;1/1/2/false/true;"), html);
});
test("saved parent references remain live and assignments inside loops remain visible", async () => {
  const html = await output(
    `{% assign sum=0 %}{% for row in (1..3) %}{% for column in (1..1) %}{% assign sum=sum|plus:row %}{% assign saved=forloop.parentloop %}{% endfor %}{% endfor %}{{sum}}|{{saved.index}}`,
  );
  assert.ok(html.includes("6|4"), html);
});
test("parent metadata respects reversed limits, continue, break and empty-loop else", async () => {
  const html = await output(
    `{% for row in (1..5) reversed limit:3 %}{{row}}:{% for column in (1..3) %}{% if column == 2 %}{% continue %}{% endif %}{{forloop.parentloop.index}}.{{forloop.index}};{% if row == 2 %}{% break %}{% endif %}{% endfor %}{% for none in empty %}{% else %}{{forloop.index}}E;{% endfor %}{% endfor %}`,
  );
  assert.ok(html.includes("3:1.1;1.3;1E;2:2.1;2E;1:3.1;3.3;3E;"), html);
});
test("reversed is recognized immediately after the collection before named modifiers", async () => {
  const html = await output(
    `{% for i in (1..3) reversed %}{{i}}{% endfor %}|{% for i in (1..5) reversed limit:3 %}{{i}}{% endfor %}|{% for i in (1..5) limit:3 reversed %}{{i}}{% endfor %}`,
  );
  assert.ok(html.includes("321|321|123"), html);
});
test("include shares parent metadata while isolated render starts a root loop", async () => {
  const input = {
    ...files(`{% for row in (1..2) %}{% include 'own' %}|{% render 'own' %};{% endfor %}`),
    "snippets/own.liquid": `{% for column in (1..1) %}{{forloop.parentloop.index|default:'root'}}.{{forloop.index}}{% endfor %}`,
  };
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/");
  assert.ok(result.html.includes("1.1|root.1;2.1|root.1;"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("saved loop references preserve the index of the iteration that breaks", async () => {
  const html = await output(
    `{% for i in (1..3) %}{% assign saved=forloop %}{% break %}{% endfor %}{{saved.index}}/{{saved.index0}}/{{saved.rindex}}/{{saved.first}}/{{saved.last}}|{% for i in (1..3) %}{% if i == 1 %}{% assign first_saved=forloop %}{% endif %}{% if i == 2 %}{% break %}{% endif %}{% endfor %}{{first_saved.index}}/{{first_saved.last}}`,
  );
  assert.ok(html.includes("1/0/3/true/false|2/false"), html);
});
test("parentloop works inside multiline liquid statements", async () => {
  const html = await output(`{% liquid
  for row in (1..2)
    for column in (1..1)
      echo forloop.parentloop.index
      echo '.'
      echo forloop.index
      echo ';'
    endfor
  endfor
%}`);
  assert.ok(html.includes("1.1;2.1;"), html);
});
test("parent loop metadata and inspector results match between Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    `{% for row in (1..2) %}{% for column in (1..2) %}{{forloop.parentloop.index}}.{{forloop.index}};{% endfor %}{% endfor %}`,
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
