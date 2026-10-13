import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function scripts(html: string) {
  return [
    ...html.matchAll(
      /data-sop-theme-scripts="([^"]+)" src="data:text\/javascript;base64,([^"]+)"/g,
    ),
  ].map((m) => ({
    type: m[1],
    code: Buffer.from(m[2] ?? "", "base64").toString("utf8"),
  }));
}
test("CSS subsets follow rendered files, JS covers all files once, and source bodies stay literal", async () => {
  const files = {
    "layout/theme.liquid":
      "<html><head>{{content_for_header}}</head><body>{{content_for_layout}}</body></html>",
    "templates/index.json":
      '{"sections":{"a":{"type":"main"},"b":{"type":"main"}},"order":["a","b"]}',
    "sections/main.liquid":
      "<p>Main</p>{% render 'own' %}{% if false %}{% stylesheet %}.main{color:red}{% endstylesheet %}{% endif %}{% javascript %}const shared='주문 🛒';{% endjavascript %}",
    "sections/unused.liquid":
      "{% stylesheet %}.unused{color:blue}{% endstylesheet %}{% javascript %}const shared='Unused';{% endjavascript %}",
    "snippets/own.liquid":
      "Snippet{% stylesheet %}.snippet{content:'{{literal}}'}{% endstylesheet %}{% javascript %}window.literal='{{not interpolated}}';{% endjavascript %}",
    "blocks/unused.liquid": "{% javascript %}window.unusedBlock=true;{% endjavascript %}",
  };
  const theme = new MemoryThemeFileSystem(files);
  const result = await renderTheme(theme, "/");
  assert.equal(result.html.match(/\.main\{color:red\}/g)?.length, 1);
  assert.equal(result.html.match(/\.snippet\{/g)?.length, 1);
  assert.ok(!result.html.includes(".unused"));
  assert.ok(!result.html.includes("sop:theme-assets"));
  assert.ok(result.html.indexOf("data-sop-theme-styles") < result.html.indexOf("</head>"));
  const bundles = scripts(result.html);
  assert.deepEqual(
    bundles.map((b) => b.type),
    ["sections", "blocks", "snippets"],
  );
  assert.equal(bundles[0]?.code.match(/const shared='주문 🛒'/g)?.length, 1);
  assert.ok(bundles[0]?.code.includes("const shared='Unused'"));
  assert.ok(bundles[1]?.code.includes("window.unusedBlock=true"));
  assert.ok(bundles[2]?.code.includes("{{not interpolated}}"));
  assert.ok(result.diagnostics.every((d) => d.code === "shopify-server-only"));
  assert.deepEqual(
    await renderTheme(
      new MemoryThemeFileSystem(Object.fromEntries(Object.entries(files).reverse())),
      "/",
    ),
    result,
  );
  for (const [file, text] of Object.entries(files)) assert.equal(await theme.readText(file), text);
});

test("bundle insertion respects HTML context, duplicate header calls, fragments and raw closing-tag strings", async () => {
  const result = await renderTheme(
    new MemoryThemeFileSystem({
      "layout/theme.liquid":
        '<html><head><script>window.fake="</head>";</script>{{content_for_header}}{{content_for_header}}</head><body>{{content_for_layout}}</body></html>',
      "templates/index.json": '{"sections":{"a":{"type":"main"}},"order":["a"]}',
      "sections/main.liquid":
        "{% stylesheet %}.x{content:'</style><p>Fake</p>'}{% endstylesheet %}",
    }),
    "/",
  );
  assert.ok(result.html.includes('window.fake="</head>"'));
  assert.ok(result.html.includes("content:'<\\/style><p>Fake</p>'"));
  assert.equal(result.html.match(/data-sop-theme-styles/g)?.length, 1);
  assert.ok(!result.html.includes("sop:theme-assets"));
  const fragment = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": '{"layout":false,"sections":{"a":{"type":"main"}},"order":["a"]}',
      "sections/main.liquid": "<p>Visible</p>{% stylesheet %}.x{color:red}{% endstylesheet %}",
    }),
    "/",
  );
  assert.ok(fragment.html.startsWith("<style data-sop-theme-styles>"));
  assert.ok(fragment.html.includes("Visible"));
});

test("duplicate asset tags are source errors rather than silently concatenated", async () => {
  for (const name of ["stylesheet", "javascript"]) {
    const result = await renderTheme(
      new MemoryThemeFileSystem({
        "templates/index.json": '{"layout":false,"sections":{"a":{"type":"main"}},"order":["a"]}',
        "sections/main.liquid": `{% ${name} %}one{% end${name} %}{% ${name} %}two{% end${name} %}`,
      }),
      "/",
    );
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.code === "liquid-error" &&
          d.file === "sections/main.liquid" &&
          d.message.includes(`Only one ${name}`),
      ),
    );
    assert.ok(!result.html.includes("data-sop-theme-styles"));
    assert.equal(scripts(result.html).length, 0);
  }
});
