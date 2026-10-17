import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function collectionTheme(body: string) {
  return new MemoryThemeFileSystem({
    "templates/collection.json":
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": body,
  });
}
const partList =
  "{% for p in paginate.parts %}{{ p.title }}{% unless p.is_link %}*{% endunless %},{% endfor %}";

// [page size, window_size, page, parts] from Shopify for a 40-product collection (2026-10-17);
// "*" marks a part that is not a link and "…" stands for "&hellip;*".
const measured: [number, number | null, number, string][] = [
  [5, null, 1, "1*,2,3,…,8"],
  [5, null, 2, "1,2*,3,4,…,8"],
  [5, null, 3, "1,2,3*,4,5,…,8"],
  [5, null, 4, "1,2,3,4*,5,6,…,8"],
  [5, null, 5, "1,…,3,4,5*,6,7,8"],
  [5, null, 6, "1,…,4,5,6*,7,8"],
  [5, null, 7, "1,…,5,6,7*,8"],
  [5, null, 8, "1,…,6,7,8*"],
  [5, null, 9, "1,…,7,8"],
  [5, 1, 1, "1*,…,8"],
  [5, 1, 2, "1,2*,…,8"],
  [5, 1, 3, "1,…,3*,…,8"],
  [5, 1, 7, "1,…,7*,8"],
  [5, 1, 8, "1,…,8*"],
  [5, 2, 1, "1*,2,…,8"],
  [5, 2, 3, "1,2,3*,4,…,8"],
  [5, 2, 4, "1,…,3,4*,5,…,8"],
  [5, 2, 6, "1,…,5,6*,7,8"],
  [5, 2, 8, "1,…,7,8*"],
  [5, 5, 1, "1*,2,3,4,5,…,8"],
  [5, 5, 3, "1,2,3*,4,5,6,7,8"],
  [5, 5, 7, "1,…,3,4,5,6,7*,8"],
  [5, 5, 8, "1,…,4,5,6,7,8*"],
  [5, 5, 10, "1,…,6,7,8"],
  [2, null, 1, "1*,2,3,…,20"],
  [2, null, 5, "1,…,3,4,5*,6,7,…,20"],
  [2, null, 16, "1,…,14,15,16*,17,18,…,20"],
  [2, null, 17, "1,…,15,16,17*,18,19,20"],
  [2, null, 20, "1,…,18,19,20*"],
];

test("paginate lists pages around the current one as Shopify does", async () => {
  for (const [size, window, page, expected] of measured) {
    const option = window === null ? "" : `, window_size: ${window}`;
    const theme = collectionTheme(
      `<p>{% paginate collection.products by ${size}${option} %}${partList}{% endpaginate %}</p>`,
    );
    const { html } = await renderTheme(theme, `/collections/sop-catalog?page=${page}`, {
      snapshot: defaultFixture(),
    });
    const actual = /<p>(.*?),?<\/p>/s.exec(html)?.[1]?.replaceAll("&hellip;*", "…");
    assert.equal(actual, expected, `by ${size}, window ${window}, page ${page}`);
  }
});

test("a single page has no parts, and default_pagination prints nothing for it", async () => {
  const snapshot = defaultFixture();
  const theme = collectionTheme(
    "<p>{% paginate collection.products by 50 %}[{{ paginate | default_pagination }}]|{{ paginate.parts.size }}|{{ paginate.pages }}|{{ paginate.items }}{% endpaginate %}</p>",
  );
  const full = await renderTheme(theme, "/collections/sop-catalog", { snapshot });
  assert.ok(full.html.includes("<p>[]|0|1|40</p>"), full.html);
  const [catalog] = snapshot.collections;
  assert.ok(catalog);
  catalog.products = [];
  const empty = await renderTheme(theme, "/collections/sop-catalog", { snapshot });
  assert.ok(empty.html.includes("<p>[]|0|1|0</p>"), empty.html);
});

test("page links keep the other query parameters, in name order", async () => {
  const theme = collectionTheme(
    "<p>{% paginate collection.products by 5 %}{{ paginate.previous.title }}|{{ paginate.previous.url }}|{{ paginate.next.title }}|{{ paginate.next.url }}{% endpaginate %}</p>",
  );
  const { html } = await renderTheme(
    theme,
    "/collections/sop-catalog?view=grid&filter.v.availability=1&page=3",
    { snapshot: defaultFixture() },
  );
  assert.ok(
    html.includes(
      "<p>&laquo; Previous|/collections/sop-catalog?filter.v.availability=1&page=2&view=grid|Next &raquo;|/collections/sop-catalog?filter.v.availability=1&page=4&view=grid</p>",
    ),
    html,
  );
});
