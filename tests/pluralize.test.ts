import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  };
}
// Reference contract: Shopify's pinned pluralize example and separate public-docs observations, never live goldens.
const cases: [string, string][] = [
  ["0", "many"],
  ["1", "one"],
  ["1.0", "one"],
  ["1.1", "many"],
  ["2", "many"],
  ["-1", "many"],
  ["'1'", "many"],
  ["'01'", "many"],
  ["'1.0'", "many"],
  ["nil", "many"],
  ["true", "many"],
  ["false", "many"],
];
const source = cases.map(([input]) => `{{ ${input}|pluralize:'one','many'}}`).join("|");
test("pluralize chooses singular only for numeric one including preserved Float literals", async () => {
  const result = await renderTheme(new MemoryThemeFileSystem(theme(source)), "/");
  assert.ok(result.html.includes(cases.map(([, expected]) => expected).join("|")), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("pluralize preserves selected label types, markup and Unicode without automatic suffixes", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      theme(
        `{{1|pluralize:nil,'many'|json}}|{{2|pluralize:'one',false|json}}|{%assign chosen=1|pluralize:7,9%}{%if chosen==7%}number{%endif%}|{{1|pluralize:'<b>한 개</b>','다수'}}|{{2|pluralize:'child','children'}}`,
      ),
    ),
    "/",
  );
  assert.ok(result.html.includes("null|false|number|<b>한 개</b>|children"), result.html);
  assert.deepEqual(result.diagnostics, []);
});
test("pluralize rejects missing or excess labels while subsequent output remains usable", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      theme(`{{1|pluralize}}|{{1|pluralize:'one'}}|{{1|pluralize:'one','many','extra'}}|After`),
    ),
    "/",
  );
  assert.equal(result.diagnostics.filter((d) => d.code === "liquid-error").length, 3);
  assert.equal(
    result.diagnostics.some((d) => d.code === "not-implemented"),
    false,
  );
  assert.ok(result.html.includes("After"));
});
test("pluralize results and diagnostics are byte-identical across Node and browser", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const files = theme(source + "|{{1|pluralize:nil,false|json}}|{{2|pluralize:'one'}}"),
    options = { inspect: true };
  assert.equal(
    JSON.stringify(
      await browser.renderTheme(new browser.MemoryThemeFileSystem(files), "/", options),
    ),
    JSON.stringify(await renderTheme(new MemoryThemeFileSystem(files), "/", options)),
  );
});
