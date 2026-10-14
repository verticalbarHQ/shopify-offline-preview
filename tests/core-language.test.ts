import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  };
}
test("empty replacement patterns insert at Unicode character boundaries including both ends", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem(
      theme(
        `{{'hi'|replace:'','x'}}|{{'😀한'|replace:'','x'}}|{{''|replace:'','x'}}|{{'abc'|replace:'',''}}|{% if 'false' contains false %}wrong{% else %}no{% endif %}|{{'aba'|replace:'a','$&'}}`,
      ),
    ),
    "/",
  );
  assert.ok(result.html.includes("xhxix|x😀x한x|x|abc|$&b$&"));
  assert.deepEqual(result.diagnostics, []);
});
test("contains never matches nil or false while retaining ordinary string and array membership", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields.own = { values: [1, null, 3, false, ""] };
  const source = `{% assign values=all_products['${product.handle}'].metafields.own.values %}{% if values contains nil %}wrong{% else %}no{% endif %}|{% if 'abc' contains nil %}wrong{% else %}no{% endif %}|{% if values contains 3 %}yes{% endif %}|{% if values contains false %}wrong{% else %}no{% endif %}|{% if values contains '' %}yes{% endif %}|{% if 'abc' contains '' %}yes{% endif %}`;
  const result = await renderTheme(new MemoryThemeFileSystem(theme(source)), "/", { snapshot });
  assert.ok(result.html.includes("no|no|yes|no|yes|yes"));
  assert.deepEqual(result.diagnostics, []);
});
test("core string and membership behavior is identical in the Node and browser builds", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const files = theme(
    `{{'😀한'|replace:'','x'}}|{% if 'abc' contains nil %}wrong{% else %}no{% endif %}|{% if 'false' contains false %}wrong{% else %}no{% endif %}|{{'aba'|replace:'a','$&'}}`,
  );
  const options = { snapshot: defaultFixture(), inspect: true };
  assert.equal(
    JSON.stringify(
      await browser.renderTheme(new browser.MemoryThemeFileSystem(files), "/", options),
    ),
    JSON.stringify(await renderTheme(new MemoryThemeFileSystem(files), "/", options)),
  );
});
