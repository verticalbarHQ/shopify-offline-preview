import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function theme(source: string) {
  return new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    ...Object.fromEntries(
      ["index", "collection", "search", "blog", "article"].map((name) => [
        `templates/${name}.json`,
        '{"sections":{"main":{"type":"main"}},"order":["main"]}',
      ]),
    ),
    "sections/main.liquid": source,
  });
}
test("collection sort choices and shared nil fields match storefront lookup behavior", async () => {
  const result = await renderTheme(
    theme(
      "{{collection.results_count|default:'nil'}}|{{collection.terms|default:'nil'}}|{{collection.current_vendor|default:'nil'}}|{{collection.current_type|default:'nil'}}|{% for option in collection.sort_options %}{{option.value}}={{option.name}};{% endfor %}",
    ),
    "/collections/sop-catalog",
  );
  assert.ok(
    result.html.includes(
      "nil|nil|nil|nil|manual=Featured;most-relevant=Most relevant;best-selling=Best selling;",
    ),
  );
  assert.ok(result.html.includes("created-descending=Date, new to old;"));
  assert.deepEqual(result.diagnostics, []);
  const snapshot = defaultFixture(),
    collection = snapshot.collections[0];
  assert.ok(collection);
  snapshot.shop.locale = "fr";
  collection.sortOptions = [{ value: "manual", name: "Source label" }];
  const custom = await renderTheme(
    theme("{{collection.sort_options.first.name}}"),
    "/collections/sop-catalog",
    { snapshot },
  );
  assert.ok(custom.html.includes("Source label"));
  assert.deepEqual(custom.diagnostics, []);
  const search = await renderTheme(
    theme("{{search.id|default:'nil'}}|{{search.url|default:'nil'}}"),
    "/search",
  );
  assert.ok(search.html.includes("nil|nil"));
  assert.deepEqual(search.diagnostics, []);
});
test("policy aliases resolve prepared policy drops, preserve body output and diagnose absent policy data", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.policies = [
    {
      id: "601",
      title: "Own shipping",
      body: "<p>Own terms</p>",
      url: "/policies/shipping-policy",
    },
  ];
  const result = await renderTheme(
    theme(
      "{{shop.shipping_policy.title}}|{{shop.shipping_policy.body}}|{{shop.shipping_policy}}|{% if shop.privacy_policy == nil %}nil{% endif %}",
    ),
    "/",
    { snapshot, inspect: true },
  );
  assert.ok(result.html.includes("Own shipping|<p>Own terms</p>|<p>Own terms</p>|nil"));
  assert.deepEqual(result.diagnostics, []);
  assert.ok(Object.values(result.dataUsed).flat().includes("shop.policies[0].body"));
  delete snapshot.shop.policies;
  assert.deepEqual(
    (await renderTheme(theme("{{shop.shipping_policy}}"), "/", { snapshot })).diagnostics.map(
      (d) => [d.code, d.message],
    ),
    [["missing-resource", "Object property shop.shipping_policy is absent from the snapshot."]],
  );
});
test("comment settings and counts use provided values, with missing metadata still visible", async () => {
  assert.deepEqual(
    (await renderTheme(theme("{{blog.comments_enabled?}}"), "/blogs/news")).diagnostics,
    [],
  );
  const article = await renderTheme(theme("{{article.comments_count}}"), "/blogs/news/story-1");
  assert.ok(article.html.includes(">0</div>"));
  assert.deepEqual(article.diagnostics, []);
  const snapshot = defaultFixture(),
    blog = snapshot.blogs[0],
    entry = blog?.articles[0];
  assert.ok(blog && entry);
  delete blog.commentsEnabled;
  delete entry.commentsCount;
  const missing = await renderTheme(
    theme("{{blog.comments_enabled?}}|{{article.comments_count}}"),
    "/blogs/news/story-1",
    { snapshot },
  );
  assert.equal(missing.diagnostics.filter((d) => d.code === "missing-resource").length, 2);
});
