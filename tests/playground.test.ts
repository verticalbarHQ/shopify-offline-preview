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
