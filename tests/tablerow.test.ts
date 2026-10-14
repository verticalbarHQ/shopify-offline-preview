import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function files(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{% capture output %}${source}{% endcapture %}<script id="result" type="application/json">{{output|json}}</script>`,
  };
}
async function output(source: string) {
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/");
  assert.deepEqual(result.diagnostics, []);
  const match = /<script id="result" type="application\/json">(.*?)<\/script>/s.exec(result.html);
  assert.ok(match, result.html);
  return JSON.parse(match[1] ?? "");
}
test("tablerow emits native row boundaries and complete cell metadata", async () => {
  assert.equal(
    await output(`{% tablerow i in (1..3) cols:2 %}{{tablerowloop.index}}:{{i}}{% endtablerow %}`),
    '<tr class="row1">\n<td class="col1">1:1</td><td class="col2">2:2</td></tr>\n<tr class="row2"><td class="col1">3:3</td></tr>\n',
  );
  assert.equal(
    await output(
      `{% tablerow i in (1..2) cols:1 %}{{tablerowloop.index0}}/{{tablerowloop.rindex}}/{{tablerowloop.rindex0}}/{{tablerowloop.col0}}/{{tablerowloop.row}}/{{tablerowloop.first}}/{{tablerowloop.last}}/{{tablerowloop.col_first}}/{{tablerowloop.col_last}}{% endtablerow %}`,
    ),
    '<tr class="row1">\n<td class="col1">0/2/1/0/1/true/false/true/true</td></tr>\n<tr class="row2"><td class="col1">1/1/0/0/2/false/true/true/true</td></tr>\n',
  );
});
test("empty lists emit an empty row while nil and false collections emit nothing", async () => {
  assert.equal(
    await output(
      `{% assign arr=''|split:',' %}{% tablerow i in arr %}x{% endtablerow %}|{%tablerow i in nil%}x{%endtablerow%}|{%tablerow i in false%}x{%endtablerow%}`,
    ),
    '<tr class="row1">\n</tr>\n||',
  );
});
test("break closes the current cell and row while continue moves to the next cell", async () => {
  assert.equal(
    await output(`{%tablerow i in (1..3) cols:2%}{{i}}{%break%}After{%endtablerow%}|After`),
    '<tr class="row1">\n<td class="col1">1</td></tr>\n|After',
  );
  assert.equal(
    await output(`{%tablerow i in (1..3) cols:2%}{{i}}{%continue%}After{%endtablerow%}`),
    '<tr class="row1">\n<td class="col1">1</td><td class="col2">2</td></tr>\n<tr class="row2"><td class="col1">3</td></tr>\n',
  );
});
test("modifiers coerce values and preserve native negative-offset slicing and unlimited columns", async () => {
  assert.equal(
    await output(
      `{%tablerow i in (1..6) cols:'2' offset:'2' limit:'3'%}{{i}}:{{tablerowloop.index}}/{{tablerowloop.length}}{%endtablerow%}`,
    ),
    '<tr class="row1">\n<td class="col1">3:1/3</td><td class="col2">4:2/3</td></tr>\n<tr class="row2"><td class="col1">5:3/3</td></tr>\n',
  );
  assert.equal(
    await output(`{%tablerow i in (1..4) cols:2.9 offset:-1 limit:2.9%}{{i}}{%endtablerow%}`),
    '<tr class="row1">\n<td class="col1">1</td></tr>\n',
  );
  assert.equal(
    await output(`{%tablerow i in (1..3) cols:0%}{{i}}{%endtablerow%}`),
    '<tr class="row1">\n<td class="col1">1</td><td class="col2">2</td><td class="col3">3</td></tr>\n',
  );
});
test("variables restore, saved metadata remains live and interrupts stay inside tablerow", async () => {
  const text = await output(
    `{%assign item='original'%}{%tablerow item in (1..3) cols:2%}{%assign saved=tablerowloop%}{%break%}{%endtablerow%}|{{item}}/{{saved.index}}/{{saved.col}}|{%for outer in (1..2)%}{%tablerow i in (1..2)%}{{forloop.index}}.{{i}}{%break%}{%endtablerow%}After{{forloop.index}};{%endfor%}`,
  );
  assert.ok(text.includes("|original/1/1|"), text);
  assert.ok(text.includes("After1;") && text.includes("After2;"), text);
  assert.ok(
    (
      await output(
        `{%tablerow i in (1..3) cols:2%}{%assign saved=tablerowloop%}{%endtablerow%}|{{saved.index}}/{{saved.col}}/{{saved.row}}`,
      )
    ).endsWith("|4/2/2"),
  );
});
test("metadata denies JSON serialization and scalar output matches the reference drop name", async () => {
  const text = await output(
    `{%tablerow i in (1..1)%}{{tablerowloop}}|{{tablerowloop|json}}{%endtablerow%}`,
  );
  assert.ok(
    text.includes('Liquid::TablerowloopDrop|{"error":"json not allowed for this object"}'),
    text,
  );
});
test("invalid modifiers report Liquid errors without swallowing following content", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      files(`{%tablerow i in (1..3) cols:true%}{{i}}{%endtablerow%}|After`),
    ),
    "/",
  );
  assert.ok(result.html.includes("invalid integer"), result.html);
  assert.ok(result.html.includes("|After"), result.html);
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});
test("classic section blocks retain inspector ownership when rendered in cells", async () => {
  const input = {
    ...files(""),
    "templates/index.json": JSON.stringify({
      sections: {
        main: {
          type: "main",
          blocks: {
            a: { type: "label", settings: { text: "A" } },
            b: { type: "label", settings: { text: "B" } },
          },
          block_order: ["b", "a"],
        },
      },
      order: ["main"],
    }),
    "sections/main.liquid": `<table>{%tablerow block in section.blocks cols:1%}<span {{block.shopify_attributes}}>{{block.settings.text}}</span>{%endtablerow%}</table>{%schema%}{"blocks":[{"type":"label","name":"Own","settings":[{"id":"text","type":"text"}]}]}{%endschema%}`,
  };
  const theme = new MemoryThemeFileSystem(input);
  const result = await renderTheme(theme, "/", { inspect: true, designMode: true });
  const blocks = result.tree[0]?.children[0]?.children;
  assert.equal(blocks?.length, 2);
  assert.ok(blocks?.every((b) => b.kind === "block" && b.file === "sections/main.liquid"));
  assert.equal((result.html.match(/<!--sop:region /g) ?? []).length, 2);
  assert.ok(result.html.indexOf(">B<") < result.html.indexOf(">A<"), result.html);
  assert.equal(await theme.readText("sections/main.liquid"), input["sections/main.liquid"]);
  assert.deepEqual(result.diagnostics, []);
});
test("cell bodies keep literal row markup intact and nested tables retain independent scopes", async () => {
  const text = await output(
    `{%tablerow i in (1..1)%}<tr class="row9">body</tr>{%tablerow j in (1..1)%}{{tablerowloop.index}}{%endtablerow%}{{tablerowloop.index}}{%endtablerow%}`,
  );
  assert.ok(text.includes('<tr class="row9">body</tr>'), text);
  assert.ok(text.endsWith("1</td></tr>\n"), text);
});
test("tablerow output and inspector metadata are identical between Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    `{%tablerow i in (1..4) cols:2%}{{tablerowloop.row}}.{{tablerowloop.col}}={{i}}{%if i==3%}{%break%}{%endif%}{%endtablerow%}`,
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
