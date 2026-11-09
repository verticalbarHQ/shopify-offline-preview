import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { type RenderResourceKind, RenderSourceError } from "../packages/data/src/render-source.js";
import { SourceSession } from "../packages/data/src/source-session.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { FixtureRenderSource } from "./helpers/render-source.js";

class WireSource extends FixtureRenderSource {
  readonly assetKeys: string[] = [];
  override async resolve(kind: RenderResourceKind, key: string) {
    assert.ok(key.length > 0 && key.length <= 4096, "Invalid lookup wire key");
    return super.resolve(kind, key);
  }
  override async asset(key: string) {
    assert.ok(key.length > 0 && key.length <= 4096, "Invalid asset wire key");
    this.assetKeys.push(key);
    return super.asset(key);
  }
}
function theme(body: string, type?: string, value?: unknown) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{ content_for_layout }}",
    "templates/index.liquid": body,
    ...(type
      ? {
          "config/settings_schema.json": JSON.stringify([
            { name: "Choices", settings: [{ type, id: "chosen", label: "Chosen" }] },
          ]),
          "config/settings_data.json": JSON.stringify({ current: { chosen: value } }),
        }
      : {}),
  });
}
function diagnosticMessages(result: Awaited<ReturnType<typeof renderTheme>>) {
  return result.diagnostics.map(({ code, message }) => ({ code, message }));
}
for (const body of [
  "before{% render 'missing' %}after",
  "before{% include 'missing' %}after",
  "before{{ 'missing.svg' | inline_asset_content }}after",
])
  for (const liquidErrors of ["inline", "omit"] as const)
    test(`missing theme reference retains diagnostics: ${body} (${liquidErrors})`, async () => {
      const snapshot = defaultFixture(),
        files = theme(body),
        paths = new Set(await files.listFiles()),
        read = files.readText.bind(files);
      files.readText = async (path) => {
        assert.ok(paths.has(path), `Must not transport missing manifest entry ${path}`);
        return read(path);
      };
      const full = await renderTheme(theme(body), "/", { snapshot, liquidErrors }),
        lazy = await renderTheme(files, "/", {
          source: new WireSource(snapshot),
          liquidErrors,
          staticPreview: true,
        });
      assert.equal(lazy.html, full.html);
      assert.deepEqual(diagnosticMessages(lazy), diagnosticMessages(full));
      assert.ok(
        lazy.diagnostics.some(({ code }) => code === "missing-resource" || code === "liquid-error"),
      );
    });

for (const target of ["snippet", "asset"] as const)
  test(`captured ${target} transport failure stays fatal with omitted Liquid errors`, async () => {
    const snapshot = defaultFixture(),
      files = new MemoryThemeFileSystem({
        "layout/theme.liquid": "{{ content_for_layout }}",
        "templates/index.liquid":
          target === "snippet"
            ? "{% render 'captured' %}"
            : "{{ 'captured.svg' | inline_asset_content }}",
        "snippets/captured.liquid": "captured",
        "assets/captured.svg": "<svg/>",
      }),
      error = new RenderSourceError("PREVIEW_INTEGRITY_FAILED", "Captured content is corrupt");
    if (target === "snippet") {
      const read = files.readText.bind(files);
      files.readText = async (path) => {
        if (path === "snippets/captured.liquid") throw error;
        return read(path);
      };
    } else {
      const read = files.readBytes.bind(files);
      files.readBytes = async (path) => {
        if (path === "assets/captured.svg") throw error;
        return read(path);
      };
    }
    await assert.rejects(
      renderTheme(files, "/", {
        source: new WireSource(snapshot),
        staticPreview: true,
        liquidErrors: "omit",
      }),
      (actual) => actual === error,
    );
  });

for (const [type, value, body] of [
  [
    undefined,
    undefined,
    "{{ all_products[''].title }}|{{ collections[''].title }}|{{ images[''].width }}",
  ],
  ["product", "", "{{ settings.chosen.title }}"],
  ["product_list", [""], "{{ settings.chosen.size }}"],
] as const)
  test(`empty lookup keys preserve nil without wire I/O (${type ?? "direct"})`, async () => {
    const snapshot = defaultFixture();
    snapshot.images = [];
    const source = new WireSource(snapshot);
    const lazy = await renderTheme(theme(body, type, value), "/", { source, staticPreview: true }),
      full = await renderTheme(theme(body, type, value), "/", { snapshot });
    assert.equal(lazy.html, full.html);
    assert.deepEqual(diagnosticMessages(lazy), diagnosticMessages(full));
    assert.deepEqual(source.resolutions, []);
    assert.deepEqual(source.assetKeys, []);
  });

test("empty lookup short circuits retain cancellation", async () => {
  const source = new WireSource(defaultFixture()),
    controller = new AbortController(),
    session = new SourceSession(source, controller.signal, (read) => read());
  controller.abort();
  await assert.rejects(async () => session.resolve("product", ""), { name: "AbortError" });
  await assert.rejects(async () => session.asset(""), { name: "AbortError" });
  assert.deepEqual(source.resolutions, []);
  assert.deepEqual(source.assetKeys, []);
});

test("nonempty long captured handles remain valid in the renderer contract", async () => {
  const snapshot = defaultFixture(),
    product = snapshot.products[0],
    key = "x".repeat(4097);
  assert.ok(product);
  product.handle = key;
  snapshot.collections = [];
  snapshot.cart.lines = [];
  const body = `{{ all_products['${key}'].title }}`,
    source = new FixtureRenderSource(snapshot);
  const full = await renderTheme(theme(body), "/", { snapshot }),
    lazy = await renderTheme(theme(body), "/", { source, staticPreview: true });
  assert.equal(lazy.html, product.title);
  assert.equal(lazy.html, full.html);
  assert.deepEqual(source.resolutions, [["product", key]]);
  await assert.rejects(
    renderTheme(theme(body), "/", { source: new WireSource(snapshot), staticPreview: true }),
    (error) => error instanceof RenderSourceError && error.code === "PREVIEW_SOURCE_READ_FAILED",
  );
});

for (const type of [
  "product",
  "collection",
  "page",
  "blog",
  "link_list",
  "product_list",
  "collection_list",
  "url",
])
  test(`missing ${type} setting preserves resource diagnostics`, async () => {
    const snapshot = defaultFixture(),
      source = new WireSource(snapshot),
      value =
        type.endsWith("_list") && type !== "link_list"
          ? ["missing", 42]
          : type === "url"
            ? "shopify://products/missing"
            : "missing",
      body =
        type.endsWith("_list") && type !== "link_list"
          ? "{{ settings.chosen.size }}"
          : "{{ settings.chosen }}";
    const full = await renderTheme(theme(body, type, value), "/", { snapshot }),
      lazy = await renderTheme(theme(body, type, value), "/", { source, staticPreview: true });
    assert.equal(lazy.html, full.html);
    assert.deepEqual(diagnosticMessages(lazy), diagnosticMessages(full));
    assert.ok(
      lazy.diagnostics.some(
        ({ message }) =>
          message === "Setting chosen references a resource absent from the snapshot.",
      ),
    );
    assert.deepEqual(source.reads, []);
  });

test("unknown setting list references stay unknown and never become invalid body reads", async () => {
  const source = new WireSource(defaultFixture());
  source.resolve = async () => ({ state: "not-captured" });
  const result = await renderTheme(
    theme("{{ settings.chosen.size }}", "product_list", ["unavailable"]),
    "/",
    { source, staticPreview: true },
  );
  assert.equal(result.html, "");
  assert.ok(result.diagnostics.some(({ code }) => code === "missing-resource"));
  assert.deepEqual(source.reads, []);
});

for (const body of [
  "{{blogs.news.articles_count}}",
  "{{blogs.news.articles_count}}:{{blogs.news.articles.size}}",
  "{{blogs.news.articles.size}}:{{blogs.news.articles_count}}",
])
  test(`article order diagnostics are emitted only when articles are accessed: ${body}`, async () => {
    const snapshot = defaultFixture(),
      blog = snapshot.blogs.find((value) => value.handle === "news");
    assert.ok(blog && blog.articles.length > 1);
    for (const article of blog.articles) Reflect.deleteProperty(article, "publishedAt");
    const source = new WireSource(snapshot),
      list = source.list.bind(source);
    source.list = async (query) => ({
      ...(await list(query)),
      ...(query.relation === "blog-articles"
        ? {
            diagnostics: [
              "Object property blog.articles order (publishedAt); snapshot order retained is absent from the snapshot.",
            ],
          }
        : {}),
    });
    const full = await renderTheme(theme(body), "/", { snapshot }),
      lazy = await renderTheme(theme(body), "/", { source, staticPreview: true });
    assert.equal(lazy.html, full.html);
    assert.deepEqual(diagnosticMessages(lazy), diagnosticMessages(full));
    assert.equal(source.lists.length, 1);
    assert.equal(source.lists[0]?.limit, 0);
    assert.equal(source.reads.flat().filter(({ kind }) => kind === "article").length, 0);
  });
