import assert from "node:assert/strict";
import { test } from "node:test";
import { Drop, Liquid } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { parseLiquid } from "../packages/render/src/parse-liquid.js";
import { PreviewContext } from "../packages/render/src/preview-context.js";
import { LiquidRange } from "../packages/render/src/range-values.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function input(source: string) {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  product.metafields.own = {
    payload: {
      items: [
        { title: "A", active: true },
        { title: "B", active: false },
        { title: "C", active: true },
      ],
      config: { active_value: true },
      numbers: { "1..3": "range" },
      payload: { title: "one two", enabled: false, empty: null, items: [1, "word"] },
      nested: [1, [2, { label: "x" }], null, false],
      escaped: { text: 'a\\q"#{value}\n', control: "\u0000", unicode: "한글" },
    },
  };
  const files = {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{%assign env=all_products['${product.handle}'].metafields.own.payload%}${source}`,
  };
  return { snapshot, files };
}
async function output(source: string, expected: string) {
  const { snapshot, files } = input(source);
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/", { snapshot });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes(expected), result.html);
}
test("filtered JSON hashes display Ruby notation rather than JavaScript object labels", async () => {
  await output(
    "{{env.items|where:'active',env.config.active_value}}",
    '{"title"=>"A", "active"=>true}{"title"=>"C", "active"=>true}',
  );
});
test("direct nested hash output inspects inner arrays while outer arrays concatenate", async () => {
  await output(
    "{{env.payload}}|{{env.nested}}",
    '{"title"=>"one two", "enabled"=>false, "empty"=>nil, "items"=>[1, "word"]}|12{"label"=>"x"}false',
  );
});
test("hash output quotes source text with Ruby escapes and preserves Unicode", async () => {
  await output(
    "{{env.escaped}}",
    String.raw`{"text"=>"a\\q\"\#{value}\n", "control"=>"\u0000", "unicode"=>"한글"}`,
  );
});
test("echo, capture and isolated snippet parameters preserve hash display", async () => {
  const { snapshot, files } = input(
    "{%liquid\necho env.config\n%}|{%capture value%}{{env.config}}{%endcapture%}{{value}}|{%render 'own',data:env.config%}|{%include 'own',data:env.config%}",
  );
  const result = await renderTheme(
    new MemoryThemeFileSystem({ ...files, "snippets/own.liquid": "{{data}}" }),
    "/",
    { snapshot },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(
    result.html.includes(
      '{"active_value"=>true}|{"active_value"=>true}|{"active_value"=>true}|{"active_value"=>true}',
    ),
    result.html,
  );
});
test("JSON filters retain JSON data and primitive output remains unchanged", async () => {
  await output(
    "{{env.config|json}}|{{env.payload|json}}|{{3.0}}|{{false}}|{{nil}}",
    '{"active_value":true}|{"title":"one two","enabled":false,"empty":null,"items":[1,"word"]}|3.0|false|',
  );
});
test("range-valued keys cannot alias string keys while literal string access remains available", async () => {
  await output(
    "{{env.numbers[(1..3)]|json}}|{%assign key=(1..3)%}{{env.numbers[key]|json}}|{{env.numbers['1..3']}}|{{env.items[(1..2)]|json}}",
    "null|null|range|null",
  );
});
test("range lookup guards survive isolated snippets and nested scopes", async () => {
  const { snapshot, files } = input(
    "{%render 'own',data:env.numbers,key:(1..3)%}|{%include 'own',data:env.numbers,key:(1..3)%}",
  );
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...files,
      "snippets/own.liquid": "{{data[key]|json}}/{{data['1..3']}}",
    }),
    "/",
    { snapshot },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.html.includes("null/range|null/range"), result.html);
});
test("preview context spawning preserves global lookup, limits and variable isolation", () => {
  const engine = new Liquid({ ownPropertyOnly: true });
  const parent = new PreviewContext(
    { local: "parent" },
    engine.options,
    { globals: { shared: "global" } },
    { liquid: engine },
  );
  const child = parent.spawn({ local: "child" });
  assert.ok(child instanceof PreviewContext);
  assert.equal(child.memoryLimit, parent.memoryLimit);
  assert.equal(child.renderLimit, parent.renderLimit);
  assert.equal(child.liquid, engine);
  assert.equal(child.getSync(["shared"]), "global");
  assert.equal(child.getSync(["local"]), "child");
  assert.equal(parent.getSync(["local"]), "parent");
  assert.equal(child.readProperty({ "1..3": "wrong" }, new LiquidRange(1, 3)), undefined);
  assert.equal(child.readProperty(Object.create({ hidden: "wrong" }), "hidden"), undefined);
});
test("hash display and range keys have identical Node and browser results", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const { snapshot, files } = input(
    "{{env.items|where:'active',env.config.active_value}}|{{env.numbers[(1..3)]|json}}|{%liquid\necho env.payload\n%}",
  );
  const options = { snapshot, inspect: true };
  assert.deepEqual(
    await browser.renderTheme(new browser.MemoryThemeFileSystem(files), "/", options),
    await renderTheme(new MemoryThemeFileSystem(files), "/", options),
  );
});
test("public output adapters preserve primitive result types and await Drop values", async () => {
  const engine = new Liquid({ keepOutputType: true });
  assert.equal(await engine.render(parseLiquid(engine, "{{3}}", "own.liquid")), 3);
  class AsyncValue extends Drop {
    valueOf() {
      return Promise.resolve("resolved");
    }
  }
  assert.equal(
    await engine.render(parseLiquid(engine, "{{value}}", "own.liquid"), {
      value: new AsyncValue(),
    }),
    "resolved",
  );
});
