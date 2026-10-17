import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

// Each source and the output Shopify rendered for it on a development store (2026-10-17).
const cases: [string, string][] = [
  ["{% if true %}\n  {%- assign x = 1 %}\n  {%- assign y = 2 -%}\n{% endif %}", ""],
  ["{% if true %}\n  {% assign x = 1 %}\n{% endif %}", ""],
  ["{% for i in (1..2) %}\n {% assign x = i %}\n{% endfor %}", ""],
  ["{% if true %} {% comment %}x{% endcomment %} {% endif %}", ""],
  ["{% if true %} a {% endif %}", " a "],
  ["{% unless false %}\n  {% capture c %}z{% endcapture %}\n{% endunless %}", ""],
  ["{% case 1 %}{% when 1 %}\n  {% assign z = 1 %}\n{% endcase %}", ""],
  ["{% if true %}\n{% liquid\n assign a = 1\n%}\n{% endif %}", ""],
  ["{% if true %}\n  {% echo '' %}\n{% endif %}", "\n  \n"],
  ["{% if true %}\n {{ '' }}\n{% endif %}", "\n \n"],
  ["{% if true %}\n{% if true %}\n{% assign a = 1 %}\n{% endif %}\n{% endif %}", ""],
  ["{% if false %}x{% else %}\n {% assign a = 1 %}\n{% endif %}", "\n \n"],
  ["{% for i in (1..2) %}\n {% break %}\n{% endfor %}", "\n "],
  ["{% capture c %}\n {% assign a = 1 %}\n{% endcapture %}({{ c }})", "(\n \n)"],
  ["{% if true %}\n {% render 'empty' %}\n{% endif %}", "\n \n"],
  ["{% if true %}\n {% increment q %}\n{% endif %}", "\n 0\n"],
  [
    "{% for i in (1..2) %}\n {% if true %}\n {% assign a = 1 %}\n {% endif %}\n{% else %}\n{% endfor %}",
    "",
  ],
  ["{% if true %}\n {% raw %}{% endraw %}\n{% endif %}", ""],
  ["{% if true %}\n {% raw %} {% endraw %}\n{% endif %}", "\n  \n"],
  ["{% if true %}\n {%- # note -%}\n{% endif %}", ""],
];

test("an if, unless, case or for block that outputs only whitespace renders nothing, as on Shopify", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": cases
      .map(([source], i) => `<pre id="c${i}">[${source}]</pre>`)
      .join(""),
    "snippets/empty.liquid": "",
  });
  const { html } = await renderTheme(theme, "/", { snapshot: defaultFixture() });
  const actual = [...html.matchAll(/<pre id="c(\d+)">\[(.*?)\]<\/pre>/gs)].map((m) => m[2]);
  assert.deepEqual(
    actual,
    cases.map(([, expected]) => expected),
  );
});

test("blank blocks inside paginate and form render nothing, and their outputs read quotes literally", async () => {
  // Shopify's output on a development store (2026-10-17).
  const theme = new MemoryThemeFileSystem({
    "templates/collection.json":
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid":
      "<p>{% paginate collection.products by 5 %}[{% if true %}\n{% assign x = 1 %}\n{% endif %}]{% endpaginate %}</p>" +
      "<p>{% form 'contact' %}[{% if true %}\n  {%- assign y = 2 %}\n{% endif %}]{% endform %}</p>" +
      "<p>{% paginate collection.products by 5 %}{{ 'a\\nb' | size }}{% endpaginate %}</p>",
  });
  const { html } = await renderTheme(theme, "/collections/sop-catalog", {
    snapshot: defaultFixture(),
  });
  const actual = [...html.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => m[1]?.replace(/<[^>]*>/g, ""));
  assert.deepEqual(actual, ["[]", "[]", "4"]);
});
