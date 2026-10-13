import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTheme } from "../packages/check/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";
import { theme } from "./fixtures.js";

test("reachable sections, groups, nested blocks, snippets, and multiline Liquid", async () => {
  const result = await checkTheme(new MemoryThemeFileSystem(theme()));
  assert.equal(result.supported, true);
  assert.equal(result.summary.complete, true);
  assert.deepEqual(result.diagnostics, []);
  const page = result.pages[0];
  assert.ok(page);
  assert.ok(page.files.includes("snippets/card.liquid"));
  assert.ok(page.files.includes("sections/header-group.json"));
  assert.ok(page.files.includes("blocks/icon.liquid"));
  assert.ok(!page.files.includes("sections/unused.liquid"));
  assert.ok(!page.files.includes("snippets/unreachable.liquid"));
  assert.ok(page.features.some((f) => f.name === "product.title"));
  assert.ok(page.features.some((f) => f.name === "variant.price"));
  assert.ok(page.features.some((f) => f.kind === "filter" && f.name === "t" && f.known));
  assert.ok(page.features.some((f) => f.kind === "tag" && f.name === "schema" && f.known));
  assert.equal(result.summary.unimplementedCount, result.summary.featureCount);
});

test("registration requires a real oracle case; known aliases resolve to canonical evidence", async () => {
  const fs = new MemoryThemeFileSystem(theme());
  const result = await checkTheme(fs, [
    { kind: "filter", name: "money", registered: true, oracleCases: [] },
    { kind: "filter", name: "translate", registered: true, oracleCases: ["oracle/translate/1"] },
  ]);
  const features = result.pages[0]?.features ?? [];
  assert.equal(features.find((f) => f.name === "money")?.implemented, false);
  assert.equal(features.find((f) => f.name === "t")?.implemented, true);
});

test("unknown filters are captured while comments and raw blocks are ignored", async () => {
  const files = theme();
  files["sections/header.liquid"] =
    "{% comment %}{{ shop | not_a_filter }}{% endcomment %}{% raw %}{{ shop | not_real }}{% endraw %}{{ shop.name | unknown_filter }}";
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages.flatMap((p) => p.features);
  assert.equal(features.find((f) => f.name === "unknown_filter")?.known, false);
  assert.ok(!features.some((f) => f.name === "not_a_filter" || f.name === "not_real"));
});

test("dynamic render and unresolved argument types keep coverage incomplete", async () => {
  const files = theme();
  files["snippets/card.liquid"] = "{% render snippet_name %}{{ passed_product.title }}";
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  assert.equal(result.summary.complete, false);
  assert.ok(result.diagnostics.some((d) => d.code === "dynamic-render"));
  assert.ok(result.diagnostics.some((d) => d.code === "unresolved-object"));
});

test("missing references and malformed Liquid are reported as errors", async () => {
  const files = theme();
  files["sections/header.liquid"] = "{% render 'missing' %}";
  const missing = await checkTheme(new MemoryThemeFileSystem(files));
  assert.ok(missing.diagnostics.some((d) => d.code === "missing-file"));
  files["sections/header.liquid"] = "{% if shop %}";
  const malformed = await checkTheme(new MemoryThemeFileSystem(files));
  assert.ok(malformed.diagnostics.some((d) => d.code === "liquid-parse-error"));
});

test("cycles terminate and repeat calls are byte-identical", async () => {
  const files = theme();
  files["snippets/card.liquid"] = "{% render 'card' %}{{ product.title }}";
  const fs = new MemoryThemeFileSystem(files);
  assert.equal(JSON.stringify(await checkTheme(fs)), JSON.stringify(await checkTheme(fs)));
});

test("layout overrides and alternate templates have separate page graphs", async () => {
  const files = theme();
  files["templates/product.alt.json"] = JSON.stringify({
    layout: false,
    sections: { main: { type: "header" } },
    order: ["main"],
  });
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const alternate = result.pages.find((p) => p.template === "templates/product.alt.json");
  assert.ok(alternate);
  assert.ok(!alternate.files.includes("layout/theme.liquid"));
  assert.ok(!alternate.files.includes("sections/product.liquid"));
});

test("vintage core templates are unsupported; excluded account pages do not affect support", async () => {
  const files = theme();
  files["templates/customers/login.liquid"] = "{{ customer }}";
  assert.equal((await checkTheme(new MemoryThemeFileSystem(files))).supported, true);
  files["templates/product.liquid"] = "{{ product.title }}";
  assert.equal((await checkTheme(new MemoryThemeFileSystem(files))).supported, false);
});

test("dictionary indexing and union-valued arrays resolve object properties without prototype keys", async () => {
  const files = theme();
  files["sections/header.liquid"] =
    "{{ all_products['sample'].title }}{% for result in search.results %}{{ result.title }}{% endfor %}{{ product.constructor }}";
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages.flatMap((p) => p.features);
  for (const name of ["product.title", "article.title", "page.title"])
    assert.ok(features.some((f) => f.name === name));
  assert.equal(features.find((f) => f.name === "product.constructor")?.known, false);
  assert.ok(!result.diagnostics.some((d) => d.code === "liquid-parse-error"));
});
