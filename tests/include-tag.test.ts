import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function files(source: string, snippet: string, name = "own") {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
    [`snippets/${name}.liquid`]: snippet,
  };
}
async function output(source: string, snippet: string, name = "own") {
  const result = await renderTheme(new MemoryThemeFileSystem(files(source, snippet, name)), "/", {
    inspect: true,
  });
  assert.deepEqual(result.diagnostics, []);
  return result;
}
test("include with and for support aliases, dynamic names and path leaf binding", async () => {
  const result = await output(
    `{%assign name='folder/own'%}{%assign value='First'%}{%include name with value as item%}|{%assign values='a,b,c'|split:','%}{%include name for values as item%}`,
    "[{{item}}]",
    "folder/own",
  );
  assert.ok(result.html.includes("[First]|[a][b][c]"), result.html);
  assert.ok(
    (await output(`{%include 'folder/own' with 'leaf'%}`, "{{own}}", "folder/own")).html.includes(
      "leaf",
    ),
  );
});
test("include parameters accumulate while render parameters remain independent", async () => {
  const result = await output(`{%include 'own',a:1,b:a%}|{%render 'own',a:1,b:a%}`, "{{a}}-{{b}}");
  assert.ok(result.html.includes("1-1|1-"), result.html);
});
test("include shares assignments and registers across iterations without creating a forloop", async () => {
  const result = await output(
    `{%assign values='a,b,c'|split:','%}{%include 'own' for values%}|{{count}}|{%cycle 'x','y'%}`,
    "[{{own}}/{{forloop.index}}]{%assign count=count|default:0|plus:1%}{%cycle 'x','y'%}",
  );
  assert.ok(result.html.includes("[a/]x[b/]y[c/]x|3|y"), result.html);
});
test("include retains an outer forloop and restores its binding after the snippet", async () => {
  const result = await output(
    `{%assign item='outer'%}{%for row in (1..2)%}{%include 'own' with 'inner' as item%}{{item}};{%endfor%}`,
    "{{item}}/{{forloop.index}}-",
  );
  assert.ok(result.html.includes("inner/1-outer;inner/2-outer;"), result.html);
});
test("break and continue from includes stop snippet content and propagate to the outer loop", async () => {
  const broke = await output(
    `{%for row in (1..3)%}{{row}}{%include 'own'%}NEVER{%endfor%}|After`,
    "{%break%}NEVER",
  );
  assert.ok(broke.html.includes("1|After"), broke.html);
  assert.ok(!broke.html.includes("NEVER"));
  const continued = await output(
    `{%for row in (1..3)%}{{row}}{%include 'own'%}NEVER{%endfor%}|After`,
    "{%continue%}NEVER",
  );
  assert.ok(continued.html.includes("123|After"), continued.html);
  assert.ok(!continued.html.includes("NEVER"));
});
test("include for propagates an interrupt and with-array repeats using shared scope", async () => {
  const result = await output(
    `{%assign values='a,b,c'|split:','%}{%for row in (1..3)%}{%include 'own' for values%}NEVER{%endfor%}|After`,
    "[{{own}}]{%break%}NEVER",
  );
  assert.ok(result.html.includes("[a]|After"), result.html);
  assert.ok(!result.html.includes("NEVER"));
  assert.ok(
    (
      await output(`{%assign values='a,b'|split:','%}{%include 'own' with values%}`, "[{{own}}]")
    ).html.includes("[a][b]"),
  );
});
test("include uses the SDK snippet parser, asset hooks and inspector ownership", async () => {
  const input = files(
    `{%include 'own'%}`,
    String.raw`{{'a\q'|json}}{%stylesheet%}.own { color: red }{%endstylesheet%}`,
  );
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/", { inspect: true });
  const snippet = result.tree[0]?.children[0]?.children[0];
  assert.equal(snippet?.kind, "snippet");
  assert.equal(snippet?.file, "snippets/own.liquid");
  assert.ok(result.html.includes(String.raw`"a\\q"`), result.html);
  assert.ok(result.html.includes(".own { color: red }"), result.html);
  assert.ok(!result.diagnostics.some((d) => d.severity === "error"));
});
test("top-level interrupts stop a file after the triggering tag", async () => {
  const result = await output(`Before{%break%}NEVER`, "unused");
  assert.ok(result.html.includes("Before"));
  assert.ok(!result.html.includes("NEVER"));
});
test("include produces identical Node/browser output, diagnostics and inspector trees", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    `{%assign values='a,b'|split:','%}{%include 'own' for values as item,a:3.0,b:a%}`,
    "{{item}}:{{a}}:{{b}}:{%cycle 'x','y'%};",
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
