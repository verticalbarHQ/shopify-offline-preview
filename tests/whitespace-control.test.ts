import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

// Each source and the output Shopify rendered for it on a development store (2026-10-17).
const cases: [string, string][] = [
  ["A\n\n  {%- if true %}B{% endif %}", "AB"],
  ["A\r\n{{- 'B' }}", "AB"],
  ["{% if true -%}  \n \n B{% endif %}", "B"],
  ["x {%- capture c %} y {% endcapture -%} z|{{ c }}|", "xz| y |"],
  ["{% for i in (1..2) -%}\n  {{ i }}\n{%- endfor %}", "1\n2\n"],
  ["{% for i in (1..2) -%}\n  {{- i }}\n{%- endfor %}", "1\n2\n"],
  ["{{ 'A' }}  \n  {{- 'B' }}", "A B"],
  ["{% assign x = 1 %}\n{%- if true %}B{% endif %}", "\nB"],
  ["{{ 'A' }}\n\n{%- if true %}B{% endif %}", "A\nB"],
  ["{{ 'A' }}x\n{%- if true %}B{% endif %}", "AxB"],
  ["{{ 'A' -}}  \n  {{- 'B' }}", "AB"],
  ["{% if true -%}\n{%- endif %}B", "B"],
  ["{{ 'A' }}\t\n{{- 'B' }}", "A\tB"],
  ["A{{ 'B' }}\n  \n{%- if true %}C{% endif %}", "AB\nC"],
  ["{{ 'A' }}\n  y  \n{%- if true %}B{% endif %}", "A\n  yB"],
  ["{% comment %}c{% endcomment %}\n{%- if true %}B{% endif %}", "\nB"],
  ["{% liquid\n  assign a = 1\n%}\n{%- if true %}B{% endif %}", "\nB"],
  ["{% render 'start' %}", " B"],
];

test("a left trim keeps the first character of a whitespace-only run that nothing trimmed before", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": cases.map(([source], i) => `<pre id="c${i}">${source}</pre>`).join(""),
    "snippets/start.liquid": "  \n{%- if true %}B{% endif %}",
  });
  const { html } = await renderTheme(theme, "/", { snapshot: defaultFixture() });
  const actual = [...html.matchAll(/<pre id="c(\d+)">(.*?)<\/pre>/gs)].map((m) => m[2]);
  assert.deepEqual(
    actual,
    cases.map(([, expected]) => expected),
  );
});
