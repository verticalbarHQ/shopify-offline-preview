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
async function output(source: string, expected: string) {
  const result = await renderTheme(new MemoryThemeFileSystem(files(source)), "/");
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes(expected), result.html);
}
test("ranges retain display identity while join and JSON enumerate numbers", async () => {
  await output(
    "{{(1..3)}}|{%assign seq=(1..3)%}{{seq}}|{{seq|join:','}}|{{seq|json}}|{{seq.first}}/{{seq.last}}/{{seq.size}}",
    "1..3|1..3|1,2,3|[1,2,3]|1/3/3",
  );
});
test("inverted ranges retain endpoints and default identity with empty iteration", async () => {
  await output(
    "{%assign seq=(3..1)%}{{seq}}|{{seq|size}}|{{seq|first}}|{{seq|last}}|{{seq|default:'fallback'}}|{%for i in seq%}wrong{%else%}emptyloop{%endfor%}|{%if empty==seq%}wrong{%else%}nonempty{%endif%}|{%if seq==blank%}wrong{%else%}nonblank{%endif%}",
    "3..1|0|3|1|3..1|emptyloop|nonempty|nonblank",
  );
});
test("range string filters and array filters preserve their different contracts", async () => {
  await output(
    "{%assign r=(1..3)%}{{r|slice:1,2|json}}|{{r|truncatewords:1}}|{{r|reverse|join:','}}|{{r|append:'x'}}|{%assign a='x,y'|split:','%}{{r|concat:a|json}}",
    '".."|1..3|3,2,1|1..3x|[1,2,3,"x","y"]',
  );
  const result = await renderTheme(
    new MemoryThemeFileSystem(files("{%assign r=(1..3)%}{{r|concat:r}}|After")),
    "/",
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
  assert.ok(result.html.includes("concat filter requires an array argument"));
  assert.ok(result.html.includes("|After"));
});
test("range comparisons reject equality while contains uses numeric membership", async () => {
  await output(
    "{%assign r=(1..3)%}{%if r==r%}wrong{%else%}unequal{%endif%}|{%if r>=r%}wrong{%else%}unordered{%endif%}|{%if r contains 2%}member{%endif%}|{%if r contains '2'%}wrong{%else%}typed{%endif%}|{%if r contains 2.5%}fraction{%else%}wrong{%endif%}",
    "unequal|unordered|member|typed|fraction",
  );
});
test("dynamic bounds are reevaluated in nested loops and liquid statements", async () => {
  await output(
    "{%for start in (1..2)%}{%assign r=(start..3)%}{{r}}:{%for i in r%}{{i}}{%endfor%};{%endfor%}|{% liquid\nassign a='-2tail'\nassign b=0\necho (a..b) | json\n%}|{{(1.9..3.8)|json}}|{{(nil..2)|json}}",
    "1..3:123;2..3:23;|[-2,-1,0]|[1,2,3]|[0,1,2]",
  );
});
test("unused branch ranges stay unevaluated and reached branches bind their context", async () => {
  await output(
    "{%assign bad=false%}{%if true%}first{%elsif (bad..3)%}wrong{%endif%}|{%unless false%}unless{%elsif (bad..3)%}wrong{%endunless%}|{%assign n=2%}{%if false%}wrong{%elsif (n..3) contains 2%}reached{%endif%}|{%case (1..3)%}{%when (1..3)%}wrong{%else%}case{%endcase%}",
    "first|unless|reached|case",
  );
});
test("invalid dynamic assignments retain prior values and report source diagnostics", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      files("{%assign r=(1..3)%}{%assign stop=4.7%}\n{%assign r=(1..stop)%}{{r}}|After"),
    ),
    "/",
  );
  assert.ok(result.html.includes("1..3|After"), result.html);
  assert.ok(!result.html.includes("Liquid error"), result.html);
  const errors = result.diagnostics.filter((d) => d.code === "liquid-error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.file, "sections/main.liquid");
  assert.equal(errors[0]?.line, 2);
});
test("snippet bindings and tablerow enumerate ranges in their actual scopes", async () => {
  const input = {
    ...files(
      "{%assign bad=false%}{%include 'value',a:2,r:(a..3)%}|{%render 'value',r:(1..2)%}|{%render 'item' for (1..3) as item%}|{%include 'item' with (2..3) as item%}|{%tablerow item in (1..2) cols:2%}{{item}}{%endtablerow%}",
    ),
    "snippets/value.liquid": "{{r}}/{{r|join:','}}",
    "snippets/item.liquid": "{{item}}",
  };
  const result = await renderTheme(new MemoryThemeFileSystem(input), "/");
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes("2..3/2,3|1..2/1,2|123|23|"), result.html);
  assert.ok(result.html.includes('<td class="col1">1</td><td class="col2">2</td>'), result.html);
});
test("range limits produce bounded diagnostics without allocating huge arrays", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(files("{{(1..999999999999999)}}|After")),
    "/",
  );
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.ok(result.html.includes("|After"), result.html);
});
test("cycle evaluates only the selected range and rejects unsafe string endpoints", async () => {
  await output("{%assign bad=false%}{%cycle 'safe',(bad..3)%}", "safe");
  const result = await renderTheme(
    new MemoryThemeFileSystem(files("{%assign low='999999999999999999999'%}{{(low..3)}}|After")),
    "/",
  );
  assert.ok(result.diagnostics.some((d) => d.code === "liquid-error"));
  assert.ok(result.html.includes("|After"), result.html);
});
test("range state, inspector results and diagnostics match in Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const input = files(
    "{%for n in (1..2)%}{%assign r=(n..3)%}{{r}}/{{r|json}};{%endfor%}|{%assign r=(3..1)%}{{r|default:'fallback'}}",
  );
  const options = { inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(input), "/", options),
    await renderTheme(new MemoryThemeFileSystem(input), "/", options),
  );
});
