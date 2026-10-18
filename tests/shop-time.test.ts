import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

// The fixture's timestamps are 2026-10-13T00:00:00Z. With the shop in America/New_York, these are
// the outputs Shopify rendered for the same instant on a development store (2026-10-17).
const cases: [string, string][] = [
  ["{{ article.published_at }}", "2026-10-12 20:00:00 -0400"],
  ["{{ article.published_at | json }}", '[0,0,20,12,10,2026,1,285,true,"EDT"]'],
  [
    "{{ article.published_at | time_tag }}",
    '<time datetime="2026-10-13T00:00:00Z">Monday, October 12, 2026 at 8:00 pm -0400</time>',
  ],
  ["{{ product.created_at | upcase }}", "2026-10-12 20:00:00 -0400"],
  ["[{{ product.created_at.year }}]", "[]"],
  ["{{ product.created_at | split: ' ' | first }}", "2026-10-12"],
  ["{{ product.created_at | size }}", "0"],
  [
    "{% if product.created_at == product.created_at %}eq{% endif %}|{% if product.created_at %}truthy{% endif %}|{% if product.created_at == blank %}blank{% else %}notblank{% endif %}",
    "eq|truthy|notblank",
  ],
];

test("timestamps print in the shop's timezone as Shopify's Liquid does", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.timezone = "America/New_York";
  const theme = new MemoryThemeFileSystem({
    "templates/product.json":
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{%- assign article = blogs.news.articles.first -%}${cases
      .map(([source]) => `<p>${source}</p>`)
      .join("")}<q>{{ product | json }}</q><s>{{ article | structured_data }}</s>`,
  });
  const { html } = await renderTheme(theme, "/products/sop-matrix-needle", { snapshot });
  assert.deepEqual(
    [...html.matchAll(/<p>(.*?)<\/p>/gs)].map((m) => m[1]),
    cases.map(([, expected]) => expected),
  );
  // Inside an object the timestamp is ISO 8601 with the shop's offset.
  const product = JSON.parse(/<q>(.*)<\/q>/s.exec(html)?.[1] ?? "{}");
  assert.equal(product.created_at, "2026-10-12T20:00:00-04:00");
  assert.equal(product.published_at, "2026-10-12T20:00:00-04:00");
  const data = /<s>(.*)<\/s>/s.exec(html)?.[1] ?? "";
  assert.ok(data.includes('"datePublished":"2026-10-12T20:00:00-04:00"'), data);
});

test("a shop in the UTC zone writes UTC and Z, as Ruby's Time does", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/product.json":
      '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": "<p>{{ product.created_at }}</p><q>{{ product | json }}</q>",
  });
  const { html } = await renderTheme(theme, "/products/sop-matrix-needle", {
    snapshot: defaultFixture(),
  });
  assert.ok(html.includes("<p>2026-10-13 00:00:00 UTC</p>"), html);
  assert.equal(
    JSON.parse(/<q>(.*)<\/q>/s.exec(html)?.[1] ?? "{}").created_at,
    "2026-10-13T00:00:00Z",
  );
});

test("timestamps compare and sort by instant, also across a daylight-saving change", async () => {
  const snapshot = defaultFixture();
  snapshot.shop.timezone = "America/New_York";
  const [first, second] = snapshot.blogs[0]?.articles ?? [];
  assert.ok(first && second);
  // 05:30Z prints as 01:30 -0400 and the later 06:15Z as 01:15 -0500.
  first.publishedAt = "2026-11-01T06:15:00Z";
  second.publishedAt = "2026-11-01T05:30:00Z";
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{%- assign a = blogs.news.articles | where: 'handle', '${first.handle}' | first -%}{%- assign b = blogs.news.articles | where: 'handle', '${second.handle}' | first -%}<p>{% if b.published_at < a.published_at %}earlier{% endif %}|{% if a.published_at > b.published_at %}later{% endif %}|{% assign sorted = blogs.news.articles | sort: 'published_at' %}{% for x in sorted %}{{ x.handle }},{% endfor %}</p>`,
  });
  const { html } = await renderTheme(theme, "/", { snapshot });
  // The third article (October) sorts first; the two November ones follow by instant.
  assert.ok(html.includes(`<p>earlier|later|story-3,${second.handle},${first.handle},`), html);
});

test("the json form names a zone and its daylight-saving state as Ruby's Time#to_a does", async () => {
  const { ShopTime } = await import("../packages/data/src/shop-time.js");
  const zone = (iso: string, timeZone: string) => new ShopTime(iso, timeZone).rubyArray().slice(8);
  assert.deepEqual(zone("2026-10-15T12:00:00Z", "Asia/Kathmandu"), [false, "+0545"]);
  assert.deepEqual(zone("2026-10-15T12:00:00Z", "Asia/Dubai"), [false, "+04"]);
  // Casablanca's +01:00 period is daylight-saving time; its standard offset is +00:00 in Ramadan.
  assert.deepEqual(zone("2026-10-15T12:00:00Z", "Africa/Casablanca")[0], true);
  assert.deepEqual(zone("2026-01-15T12:00:00Z", "America/New_York"), [false, "EST"]);
});
