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
test("unnamed variable cycles have independent tag counters that persist through loop iterations", async () => {
  const html = await output(
    `{%assign x='a'%}{%cycle x,'b'%}{%cycle x,'b'%}|{%for i in(1..3)%}{%cycle x,'b'%}{%cycle x,'b'%}{%endfor%}`,
  );
  assert.ok(html.includes("aa|aabbaa"), html);
});
test("literal cycle counters share by values across quotes and integer or float spellings", async () => {
  const html = await output(
    `{%cycle 'm','n'%}{%cycle "m","n"%}|{%cycle 1,2%}{%cycle 1.0,2.0%}|{%for i in(1..3)%}{%cycle 'a','b'%}{%endfor%}-{%cycle 'a','b'%}`,
  );
  assert.ok(html.includes("mn|12.0|aba-b"), html);
});
test("named cycles share their evaluated name across different candidate lists safely", async () => {
  const html = await output(
    `{%assign name='same'%}{%cycle name:'a','b'%}{%cycle 'same':'x','y','z'%}{%cycle name:'p','q'%}{%cycle name:'0','1','2','3'%}|{%cycle '__proto__':'1','2'%}{%cycle '__proto__':'1','2'%}|{%cycle 'q':'a','b','c','d'%}{%cycle 'q':'a','b','c','d'%}{%cycle 'q':'a','b','c','d'%}{%cycle 'q':'x','y'%}`,
  );
  assert.ok(html.includes("ayp3|12|abcy"), html);
});
test("render has isolated cycle registers while include shares its caller's counters", async () => {
  const input = {
    ...files(
      `{%cycle 'a','b'%}{%render 'own'%}{%cycle 'a','b'%}|{%cycle 'group':'x','y'%}{%include 'named'%}{%cycle 'group':'x','y'%}`,
    ),
    "snippets/own.liquid": "{%cycle 'a','b'%}",
    "snippets/named.liquid": "{%cycle 'group':'x','y'%}",
  };
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/");
  assert.ok(result.html.includes("aab|xyx"), result.html);
  assert.deepEqual(result.diagnostics, []);
  assert.equal((await renderTheme(new MemoryThemeFileSystem(input), "/")).html, result.html);
});
test("cycle arrays concatenate their items and empty syntax fails visibly", async () => {
  assert.ok(
    (
      await output(`{%cycle (1..3),'x'%}|{%assign vals='a,b,c'|split:','%}{%cycle vals,'x'%}`)
    ).includes("1..3|abc"),
  );
  const result = await renderTheme(new MemoryThemeFileSystem(files(`{%cycle%}`)), "/");
  assert.ok(result.html.includes("Cycle requires candidates"), result.html);
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});
test("cycle counter grouping produces identical Node and browser results", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    `{%assign x=3.0%}{%for i in(1..3)%}{%cycle x,'b'%}{%cycle x,'b'%}{%endfor%}|{%cycle 'same':'a','b'%}{%cycle 'same':'x','y','z'%}`,
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
