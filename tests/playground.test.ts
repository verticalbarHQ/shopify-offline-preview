import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { normalizeFiles, readZip } from "../packages/playground/src/files.js";
import { playgroundPreview } from "../packages/playground/src/preview.js";
import {
  prepareResources,
  resourceUrl,
  rewriteModule,
} from "../packages/playground/src/resources.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

test("zip and folder adapters reject traversal before common-root stripping", () => {
  const bytes = strToU8("hello");
  assert.deepEqual(
    Object.keys(
      readZip(
        zipSync({ "theme/layout/theme.liquid": bytes, "theme/assets/a.js": bytes }),
        "layout/theme.liquid",
      ),
    ),
    ["layout/theme.liquid", "assets/a.js"],
  );
  for (const name of [
    "../layout/theme.liquid",
    "a/../layout/theme.liquid",
    "/layout/theme.liquid",
    "a\\layout/theme.liquid",
    "a//layout/theme.liquid",
  ]) {
    assert.throws(() => normalizeFiles([[name, bytes]], "layout/theme.liquid"));
    assert.throws(() => readZip(zipSync({ [name]: bytes }), "layout/theme.liquid"));
  }
  assert.throws(
    () =>
      normalizeFiles(
        [
          ["theme/layout/theme.liquid", bytes],
          ["unrelated.txt", bytes],
        ],
        "layout/theme.liquid",
      ),
    /outside/,
  );
  assert.throws(
    () =>
      normalizeFiles(
        [
          ["layout/theme.liquid", bytes],
          ["layout/theme.liquid", bytes],
        ],
        "layout/theme.liquid",
      ),
    /Duplicate/,
  );
});
test("browser resource adapters preserve cyclic and dynamic imports, CSS images and raw files", async () => {
  const files = {
    "assets/a.js": strToU8('import {b} from "./b.js"; import("./b.js"); export const a=1;'),
    "assets/b.js": strToU8('import {a} from "./a.js"; export const b=2;'),
    "assets/base.css": strToU8('body{background:url("./a.svg")}'),
    "assets/main.css": strToU8('@import "./base.css";'),
    "assets/a.svg": strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  };
  const result = await prepareResources(files, { "x.png": new Uint8Array([1, 2, 3]) });
  assert.match(
    await rewriteModule(new TextDecoder().decode(files["assets/a.js"]), "assets/a.js", files),
    /import\("sop-asset:assets\/b.js"\)/,
  );
  assert.match(result.imports["sop-asset:assets/a.js"] ?? "", /^data:text\/javascript;base64,/);
  assert.match(result.urls[resourceUrl("x.png")] ?? "", /^data:image\/png;base64,/);
  const css = Buffer.from(
    (result.urls[resourceUrl("assets/base.css")] ?? "").split(",")[1] ?? "",
    "base64",
  ).toString();
  assert.match(css, /data:image\/svg\+xml;base64/);
  await assert.rejects(
    prepareResources(
      {
        "assets/a.css": strToU8('@import "./b.css";'),
        "assets/b.css": strToU8('@import "./a.css";'),
      },
      {},
    ),
    /Circular CSS/,
  );
});
test("served browser view is isolated from core output and injects scripts before theme execution", async () => {
  const files = {
    "layout/theme.liquid": strToU8(
      '<!doctype html><html><head><script src="/sop/assets/a.js"></script></head><body>{{content_for_layout}}</body></html>',
    ),
    "templates/index.json": strToU8('{"sections":{"main":{"type":"main"}},"order":["main"]}'),
    "sections/main.liquid": strToU8("<h1>{{shop.name}}</h1>"),
    "assets/a.js": strToU8("window.themeAssetRan=true;"),
  };
  const snapshot = defaultFixture();
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/", {
    snapshot,
    inspect: true,
  });
  const original = result.html;
  const html = await playgroundPreview(
    result,
    snapshot,
    files,
    {},
    "window.bridgeRan=true;",
    false,
    "one",
    "https://inspector.test",
  );
  assert.equal(result.html, original);
  assert.ok(html.indexOf("window.bridgeRan=true;") < html.indexOf('src="data:text/javascript'));
  assert.match(html, /https:\/\/sop-preview.invalid\//);
  assert.match(html, /inspector\.test/);
  assert.ok(!html.includes('src="/sop/bridge.js"'));
});

test("preview rewrites resources inside nested and declarative shadow templates", async () => {
  const files = {
    "layout/theme.liquid": strToU8("<html><head></head><body>{{content_for_layout}}</body></html>"),
    "templates/index.json": strToU8('{"sections":{"main":{"type":"main"}},"order":["main"]}'),
    "sections/main.liquid": strToU8(
      `<div><template shadowrootmode="open"><link rel="stylesheet" href="/sop/assets/shadow.css"><img src="/sop/images/hero.svg" srcset="/sop/images/hero.svg 1x"><template><style>.hero{background:url('/sop/images/hero.svg')}</style><script src="/sop/assets/shadow.js"></script></template></template></div>`,
    ),
    "assets/shadow.css": strToU8("ul{display:flex;list-style:none}"),
    "assets/shadow.js": strToU8("window.shadowScriptLoaded=true"),
  };
  const images = { "hero.svg": strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>') };
  const snapshot = defaultFixture();
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/", { snapshot });
  const original = result.html;
  const html = await playgroundPreview(
    result,
    snapshot,
    files,
    images,
    "window.bridgeRan=true;",
    false,
    "shadow",
    "https://inspector.test",
  );
  assert.equal(result.html, original);
  assert.match(
    html,
    /<template shadowrootmode="open"><link rel="stylesheet" href="data:text\/css;base64,/,
  );
  assert.match(html, /<img src="data:image\/svg\+xml;base64,/);
  assert.match(html, /srcset="data:image\/svg\+xml;base64,[^"]+ 1x"/);
  assert.match(html, /<template><style>\.hero\{background:url\("data:image\/svg\+xml;base64,/);
  assert.match(html, /<script src="data:text\/javascript;base64,/);
  assert.ok(!html.includes('href="/sop/assets/shadow.css"'));
});

test("snapshot images without files show the dev server's placeholder instead of failing", async () => {
  const snapshot = defaultFixture();
  const resources = await prepareResources({}, {}, [{ file: "gone.png", width: 40, height: 20 }]);
  const placeholder = resources.urls[resourceUrl("gone.png")];
  assert.ok(placeholder);
  assert.ok(placeholder.startsWith("data:image/svg+xml;base64,"));
  assert.match(atob(placeholder.slice(26)), /width="40" height="20"/);
  const files = {
    "layout/theme.liquid": "{{ content_for_layout }}",
    "templates/product.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": "{{ product.featured_image | image_url: width: 32 | image_tag }}",
  };
  const result = await renderTheme(
    new MemoryThemeFileSystem(files),
    `/products/${snapshot.products[0]?.handle}`,
    { snapshot },
  );
  const html = await playgroundPreview(
    result,
    snapshot,
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
    {},
    "",
    false,
    "missing",
    "https://inspector.test",
  );
  assert.match(html, /<img src="data:image\/svg\+xml;base64,/);
});
