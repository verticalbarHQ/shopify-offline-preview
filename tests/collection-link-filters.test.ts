import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

async function render(source: string) {
  const snapshot = defaultFixture();
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/collection.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": source,
  });
  return renderTheme(theme, `/collections/${snapshot.collections[0]?.handle}`, {
    snapshot,
    inspect: true,
  });
}

test("catalog URL filters encode UTF-8, spaces and RFC3986 punctuation without changing case", async () => {
  const result = await render(
    `{{ "O'Reilly & 음/?#!()*~" | url_for_vendor }}|{{ "O'Reilly & 음/?#!()*~" | url_for_type }}|{{ nil | url_for_type }}|{{ false | url_for_vendor }}`,
  );
  assert.ok(
    result.html.includes(
      "/collections/vendors?q=O%27Reilly%20%26%20%EC%9D%8C%2F%3F%23%21%28%29%2A~",
    ),
  );
  assert.ok(
    result.html.includes("/collections/types?q=O%27Reilly%20%26%20%EC%9D%8C%2F%3F%23%21%28%29%2A~"),
  );
  assert.ok(result.html.includes("|/collections/types?q=|/collections/vendors?q=false"));
  assert.deepEqual(result.diagnostics, []);
});

test("catalog links preserve label markup, escape attributes, override href and retain default or explicit titles", async () => {
  const result = await render(
    `{{ "<b>O'Reilly & 음</b>" | link_to_vendor }}|{{ 'x' | link_to_type: class: '<x>', title: 'custom', href: '/wrong', hidden: true, disabled: false }}|{{ 'x' | link_to_vendor: target: '_blank' }}|{{ nil | link_to_vendor }}|{{ '  ' | link_to_type }}|{{ false | link_to_type }}|{{ 0 | link_to_type }}`,
  );
  for (const expected of [
    '<a href="/collections/vendors?q=%3Cb%3EO%27Reilly%20%26%20%EC%9D%8C%3C%2Fb%3E" title="&lt;b&gt;O&#39;Reilly &amp; 음&lt;/b&gt;"><b>O\'Reilly & 음</b></a>',
    '<a class="&lt;x&gt;" title="custom" href="/collections/types?q=x" hidden="hidden">x</a>',
    '<a target="_blank" href="/collections/vendors?q=x" title="x">x</a>',
    'Unknown Vendor|Unknown Type|Unknown Type|<a href="/collections/types?q=0" title="0">0</a>',
  ])
    assert.ok(result.html.includes(expected), expected);
  assert.deepEqual(result.diagnostics, []);
});

test("sort_by appends rather than replaces existing queries and keeps fragments and original encoding", async () => {
  const result = await render(
    `{{ '/collections/x?tag=a%20b&sort_by=manual#part' | sort_by: 'price-ascending' }}|{{ 'https://example.invalid/collections/x?q=A%26B' | sort_by: 'made up&sort' }}|{{ '/x?' | sort_by: 'manual' }}|{{ '' | sort_by: 'title-ascending' }}|{{ '/x?q=1#h' | sort_by: false }}|{{ '/x?q=1#h' | sort_by: nil }}`,
  );
  assert.ok(
    result.html.includes("/collections/x?tag=a%20b&sort_by=manual&sort_by=price-ascending#part"),
  );
  assert.ok(
    result.html.includes("https://example.invalid/collections/x?q=A%26B&sort_by=made%20up%26sort"),
  );
  assert.ok(result.html.includes("/x?sort_by=manual|?sort_by=title-ascending|/x?q=1#h|/x?q=1#h"));
  assert.deepEqual(result.diagnostics, []);
  const bad = await render("{{ nil | sort_by: 'manual' }}");
  assert.equal(bad.diagnostics.filter((d) => d.code === "liquid-error").length, 1);
});

test("within prefixes only genuine collection objects and preserves product queries without rewriting paths", async () => {
  const result = await render(
    `{{ '/products/x?variant=123#media' | within: collection }}|{{ '/collections/old/products/x' | within: collection }}|{{ '/pages/x' | within: collection }}|{{ '/products/x' | within: nil }}|{{ '/products/x' | within: 'all' }}|{{ '/products/x' | within: collections.all }}|{{ nil | within: collection }}`,
  );
  const path = `/collections/${defaultFixture().collections[0]?.handle}`;
  assert.ok(
    result.html.includes(
      `${path}/products/x?variant=123#media|${path}/collections/old/products/x|${path}/pages/x|/products/x|/products/x|/collections/all/products/x|${path}`,
    ),
  );
  assert.deepEqual(result.diagnostics, []);
});

test("catalog URL and anchor rendering is byte-identical in Node and the browser bundle", async () => {
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  const snapshot = defaultFixture();
  const files = {
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/collection.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{{ "O'Reilly & 음" | link_to_vendor: class: '<x>' }}|{{ 'Supplies' | url_for_type | sort_by: 'best-selling' }}|{{ '/products/x?variant=123#media' | within: collection }}|{{ nil | sort_by: 'manual' }}`,
  };
  const path = `/collections/${snapshot.collections[0]?.handle}`;
  const options = { snapshot, inspect: true };
  assert.equal(
    JSON.stringify(
      await browser.renderTheme(new browser.MemoryThemeFileSystem(files), path, options),
    ),
    JSON.stringify(await renderTheme(new MemoryThemeFileSystem(files), path, options)),
  );
});
