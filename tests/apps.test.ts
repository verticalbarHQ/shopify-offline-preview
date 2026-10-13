import assert from "node:assert/strict";
import { test } from "node:test";
import { appendAppEmbeds, appIdentity, appMarkup } from "../packages/render/src/apps.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const type = "shopify://apps/example-reviews/blocks/rating/synthetic-extension";
const base = {
  "layout/theme.liquid":
    "<!doctype html><html><head></head><body>{{content_for_layout}}</body></html>",
  "templates/index.json": JSON.stringify({
    sections: {
      main: {
        type: "main",
        blocks: { app: { type }, off: { type, disabled: true } },
        block_order: ["app", "off"],
      },
    },
    order: ["main"],
  }),
};
test("classic app types expose @app and render labelled placeholders with source-owned nodes", async () => {
  const files = {
    ...base,
    "sections/main.liquid":
      '{% for block in section.blocks %}{% case block.type %}{% when \'@app\' %}{% render block %}{% endcase %}{% endfor %}{% schema %}{"blocks":[{"type":"@app"}]}{% endschema %}',
  };
  const theme = new MemoryThemeFileSystem(files);
  const result = await renderTheme(theme, "/");
  assert.ok(result.html.includes("External app: example-reviews / rating"));
  assert.equal((result.html.match(/sop-app-placeholder/g) ?? []).length, 1);
  const node = result.tree[0]?.children[0]?.children[0];
  assert.ok(node);
  assert.equal(node.type, "@app");
  assert.equal(node.file, "sections/main.liquid");
  assert.equal(node.settingsPath, "templates/index.json#/sections/main/blocks/app");
  assert.equal(node.children.length, 0);
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["app-placeholder"],
  );
  assert.equal(result.diagnostics[0]?.nodeId, node.id);
  assert.equal(await theme.readText("sections/main.liquid"), files["sections/main.liquid"]);
});
test("dynamic theme app blocks become placeholders rather than missing blocks or Liquid errors", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "sections/main.liquid":
        '{% content_for \'blocks\' %}{% schema %}{"blocks":[{"type":"@app"}]}{% endschema %}',
    }),
    "/",
  );
  const node = result.tree[0]?.children[0]?.children[0];
  assert.ok(node);
  assert.equal(node.file, "templates/index.json");
  assert.ok(result.html.includes("example-reviews / rating"));
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["app-placeholder"],
  );
});
test("enabled app embeds use the selected settings preset and map to its actual JSON pointer", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "sections/main.liquid": "Page",
      "config/settings_data.json": JSON.stringify({
        current: "Custom/Name",
        presets: {
          "Custom/Name": { blocks: { "embed/id": { type }, off: { type, disabled: true } } },
        },
      }),
    }),
    "/",
  );
  const embed = result.tree.at(-1);
  assert.ok(embed);
  assert.equal(
    embed.settingsPath,
    "config/settings_data.json#/presets/Custom~1Name/blocks/embed~1id",
  );
  assert.ok(result.html.indexOf("sop-app-placeholder") < result.html.lastIndexOf("</body>"));
  assert.equal((result.html.match(/sop-app-placeholder/g) ?? []).length, 1);
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["app-placeholder"],
  );
});
test("app labels are escaped and embed insertion cannot mistake a script string for a body close", () => {
  const markup = "<p>App placeholder</p>";
  const source = '<html><body><script>const close="</body>";</script>Page</body></html>';
  assert.equal(
    appendAppEmbeds(source, markup),
    '<html><body><script>const close="</body>";</script>Page<p>App placeholder</p></body></html>',
  );
  assert.equal(appendAppEmbeds("<p>Fragment</p>", markup), `<p>Fragment</p>${markup}`);
  assert.deepEqual(appIdentity("shopify://apps/a%22b/blocks/rating%3Cbad%3E/id"), {
    app: 'a"b',
    block: "rating<bad>",
  });
  const escaped = appMarkup("shopify://apps/a%22b/blocks/rating%3Cbad%3E/id");
  assert.ok(escaped.includes('data-sop-app="a&quot;b"'));
  assert.ok(escaped.includes("rating&lt;bad&gt;"));
  assert.ok(!escaped.includes("<bad>"));
  assert.throws(() => appIdentity("shopify://apps/invalid"), /Invalid/);
});
test("a dynamic snippet name still reports unsupported after app resolution", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      ...base,
      "templates/index.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      "sections/main.liquid": "{% assign name='anything' %}{% render name %}",
    }),
    "/",
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ["not-implemented"],
  );
});
