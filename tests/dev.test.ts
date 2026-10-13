import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { isBlockedEndpoint } from "../packages/dev/src/endpoints.js";
import { previewRegions, servedPreview, startDevServer } from "../packages/dev/src/server.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const files = {
  "templates/index.json": JSON.stringify({
    sections: { main: { type: "example", settings: { product: "missing" } } },
    order: ["main"],
  }),
  "layout/theme.liquid":
    "<!doctype html><html><head><title>Preview</title></head><body>{{ content_for_layout }}</body></html>",
  "sections/example.liquid":
    '{{shop.name}}|{{request.design_mode}}{% schema %}{"tag":"section","settings":[{"type":"product","id":"product"}]}{% endschema %}',
  "assets/example.css": "body{color:red}",
  "config/private.json": "PRIVATE_NOT_EXPOSED",
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sop-dev-"));
  const theme = join(root, "theme");
  const data = join(root, "data");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(theme, file)), { recursive: true });
    await writeFile(join(theme, file), text);
  }
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "snapshot.json"), JSON.stringify(defaultFixture()));
  return { root, theme, data };
}

test("server endpoint detection rejects Shopify APIs while preserving ordinary page routes", () => {
  for (const path of [
    "/cart.js",
    "/cart/add",
    "/cart/change.js",
    "/cart/update.js",
    "/cart/clear.js",
    "/search/suggest",
    "/recommendations/products?product_id=1",
    "/products/example.js",
    "/?section_id=main",
    "/?sections=header,footer",
  ])
    assert.equal(isBlockedEndpoint(new URL(path, "http://127.0.0.1")), true, path);
  for (const path of ["/cart", "/search?q=product", "/products/example", "/collections/all"])
    assert.equal(isBlockedEndpoint(new URL(path, "http://127.0.0.1")), false, path);
});

test("preview instrumentation lives only in served HTML and keeps section source boundaries", async () => {
  const result = await renderTheme(new MemoryThemeFileSystem(files), "/", {
    snapshot: defaultFixture(),
    inspect: true,
  });
  assert.ok(!result.html.includes("sop-bridge"));
  const view = servedPreview(result, "http://127.0.0.1:12345");
  assert.match(view, /^<!DOCTYPE html>/i);
  assert.ok(view.indexOf("/sop/bridge.js") < view.indexOf("<title>"));
  assert.deepEqual(previewRegions(result.tree), [
    { nodeId: result.tree[0]?.children[0]?.id, domId: "shopify-section-template--0__main" },
  ]);
  assert.ok(view.includes('id="shopify-section-template--0__main"'));
  assert.equal(result.diagnostics[0]?.code, "missing-resource");
});

test("two loopback origins preserve render contracts, reject cross-origin/source escapes, and serve 501/asset/image responses", async () => {
  const { root, theme, data } = await setup();
  const session = await startDevServer({
    themeDirectory: theme,
    dataDirectory: data,
    port: 0,
    designMode: true,
  });
  try {
    assert.notEqual(session.inspectorOrigin, session.previewOrigin);
    const config = await (await fetch(`${session.inspectorOrigin}/api/config`)).json();
    assert.equal(config.previewOrigin, session.previewOrigin);
    assert.equal(config.designMode, true);
    const result = await (
      await fetch(`${session.inspectorOrigin}/api/render?path=/&scenario=default&designMode=true`)
    ).json();
    const expected = await renderTheme(new MemoryThemeFileSystem(files), "/", {
      snapshot: defaultFixture(),
      inspect: true,
      designMode: true,
    });
    assert.deepEqual(result, expected);
    const view = await (await fetch(`${session.previewOrigin}/?__sop_design_mode=true`)).text();
    assert.ok(view.includes("/sop/bridge.js"));
    assert.ok(view.includes("|true"));
    assert.ok((await (await fetch(`${session.inspectorOrigin}/`)).text()).includes('id="preview"'));
    assert.equal(
      (
        await fetch(`${session.inspectorOrigin}/api/config`, {
          headers: { Origin: session.previewOrigin },
        })
      ).status,
      403,
    );
    const spoofedHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = get(
        `${session.inspectorOrigin}/api/config`,
        { headers: { Host: "evil.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.once("error", reject);
    });
    assert.equal(spoofedHost, 403);
    assert.equal((await fetch(`${session.inspectorOrigin}/api/source?file=../secret`)).status, 400);
    const denied = await fetch(`${session.inspectorOrigin}/api/source?file=config/private.json`);
    assert.equal(denied.status, 404);
    assert.ok(!(await denied.text()).includes("PRIVATE_NOT_EXPOSED"));
    assert.equal(
      await (
        await fetch(`${session.inspectorOrigin}/api/source?file=sections/example.liquid`)
      ).text(),
      files["sections/example.liquid"],
    );
    for (const path of ["/cart.js", "/cart/add.js", "/?section_id=main", "/products/example.js"]) {
      const response = await fetch(session.previewOrigin + path);
      assert.equal(response.status, 501);
      assert.deepEqual(await response.json(), { error: "not available offline" });
    }
    assert.equal(
      (await fetch(`${session.previewOrigin}/cart/add`, { method: "POST", body: "ignored" }))
        .status,
      501,
    );
    const asset = await fetch(`${session.previewOrigin}/sop/assets/example.css`);
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get("content-type")?.includes("text/css"));
    assert.equal(await asset.text(), files["assets/example.css"]);
    assert.equal(
      (await fetch(`${session.previewOrigin}/sop/assets/%2e%2e%2fprivate.json`)).status,
      400,
    );
    const placeholder = await fetch(
      `${session.previewOrigin}/sop/images/missing.png?width=120&height=80`,
    );
    assert.equal(placeholder.status, 200);
    assert.ok(placeholder.headers.get("content-type")?.includes("image/svg+xml"));
    assert.match(await placeholder.text(), /width="120" height="80"/);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("file and snapshot edits invalidate cached renders and notify connected inspectors", async () => {
  const { root, theme, data } = await setup();
  const session = await startDevServer({ themeDirectory: theme, dataDirectory: data, port: 0 });
  const abort = new AbortController();
  try {
    const events = await fetch(`${session.inspectorOrigin}/events`, { signal: abort.signal });
    const reader = events.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.ok(new TextDecoder().decode(first.value).includes("connected"));
    const before = await (await fetch(`${session.inspectorOrigin}/api/render?path=/`)).json();
    await writeFile(join(theme, "sections/example.liquid"), "EDITED {{shop.name}}");
    const changed = await reader.read();
    assert.ok(new TextDecoder().decode(changed.value).includes("changed"));
    const after = await (await fetch(`${session.inspectorOrigin}/api/render?path=/`)).json();
    assert.notEqual(after.html, before.html);
    assert.ok(after.html.includes("EDITED"));
    const snapshot = defaultFixture();
    snapshot.shop.name = "Changed local snapshot";
    await writeFile(join(data, "snapshot.json"), JSON.stringify(snapshot));
    const dataChange = await reader.read();
    assert.ok(new TextDecoder().decode(dataChange.value).includes("changed"));
    const updated = await (await fetch(`${session.inspectorOrigin}/api/render?path=/`)).json();
    assert.ok(updated.html.includes(snapshot.shop.name));
    await reader.cancel();
  } finally {
    abort.abort();
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("settings JSON source is available only after an app node references it, with private config still denied", async () => {
  const { root, theme, data } = await setup();
  const config = JSON.stringify({
    current: {
      blocks: { embed: { type: "shopify://apps/example/blocks/embed/synthetic-extension" } },
    },
  });
  await writeFile(join(theme, "config/settings_data.json"), config);
  const session = await startDevServer({ themeDirectory: theme, dataDirectory: data, port: 0 });
  try {
    const source = `${session.inspectorOrigin}/api/source?file=config/settings_data.json`;
    assert.equal((await fetch(source)).status, 404);
    const rendered = await fetch(
      `${session.inspectorOrigin}/api/render?path=%2F&scenario=default&designMode=false`,
    );
    assert.equal(rendered.status, 200);
    const allowed = await fetch(source);
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), config);
    assert.equal(
      (await fetch(`${session.inspectorOrigin}/api/source?file=config/private.json`)).status,
      404,
    );
    assert.equal((await fetch(source, { headers: { Origin: session.previewOrigin } })).status, 403);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
