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

test("assignment order and loop scopes avoid invented resource properties", async () => {
  const files = theme();
  files["sections/header.liquid"] = `{% assign resource=product %}{{resource.title}}
{% assign resource=collection %}{{resource.products}}
{% for resource in product.variants %}{{resource.price}}{% endfor %}{{resource.products}}`;
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages[0]?.features ?? [];
  for (const name of ["product.title", "collection.products", "variant.price"])
    assert.ok(features.some((feature) => feature.name === name));
  for (const name of ["product.products", "collection.price", "variant.products"])
    assert.ok(!features.some((feature) => feature.name === name));
  assert.ok(!result.diagnostics.some((d) => d.file === "sections/header.liquid"));
});

test("branch assignments merge possible types and preserve paths that do not reassign", async () => {
  const files = theme();
  files["sections/header.liquid"] = `{% assign resource=product %}
{% if request.design_mode %}{% assign resource=collection %}{{resource.products}}{% else %}{{resource.price}}{% endif %}
{{resource.title}}`;
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages[0]?.features ?? [];
  assert.ok(features.some((feature) => feature.name === "collection.products"));
  assert.ok(features.some((feature) => feature.name === "product.price"));
  assert.ok(features.some((feature) => feature.name === "collection.title"));
  assert.ok(features.some((feature) => feature.name === "product.title"));
  assert.ok(
    !features.some((feature) => ["product.products", "collection.price"].includes(feature.name)),
  );
  files["sections/header.liquid"] =
    "{% if request.design_mode %}{% assign product=collection %}{% endif %}{{product.title}}";
  const untouched = (await checkTheme(new MemoryThemeFileSystem(files))).pages[0]?.features ?? [];
  assert.ok(untouched.some((feature) => feature.name === "collection.title"));
  assert.ok(untouched.some((feature) => feature.name === "product.title"));
});

test("default and array filters retain source types but unknown filter results stay incomplete", async () => {
  const files = theme();
  files["sections/header.liquid"] =
    `{% assign selected=product.selected_variant | default: product.variants.first %}{{selected.price}}
{% assign variants=product.variants | where: 'available', true | reverse %}{% for item in variants %}{{item.sku}}{% endfor %}
{% assign names=product.variants | map: 'title' %}{% for label in names %}{{label.size}}{% endfor %}
{% assign product=product | unknown_filter %}{{product.title}}`;
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages[0]?.features ?? [];
  assert.ok(features.some((feature) => feature.name === "variant.price"));
  assert.ok(features.some((feature) => feature.name === "variant.sku"));
  assert.ok(!features.some((feature) => feature.name === "variant.size"));
  assert.ok(
    !features
      .find((feature) => feature.name === "product.title")
      ?.occurrences.some((occurrence) => occurrence.file === "sections/header.liquid"),
  );
  assert.equal(result.summary.complete, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unresolved-object" && diagnostic.message.includes("product"),
    ),
  );
});

test("liquid statement groups preserve source order and capture overwrites object aliases", async () => {
  const files = theme();
  files["sections/header.liquid"] = `{% liquid
assign value = product
echo value.title
assign value = collection
echo value.products
%}{% capture value %}Plain text{% endcapture %}{{value.size}}`;
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages[0]?.features ?? [];
  assert.ok(features.some((feature) => feature.name === "product.title"));
  assert.ok(features.some((feature) => feature.name === "collection.products"));
  assert.ok(
    !features.some((feature) =>
      ["product.products", "product.size", "collection.size"].includes(feature.name),
    ),
  );
});

test("default retains uncertainty from untyped caller input and browser analysis matches Node", async () => {
  const files = theme();
  files["sections/header.liquid"] =
    "{% assign resource = caller_input | default: product %}{{resource.title}}";
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  assert.equal(result.summary.complete, false);
  assert.ok(result.pages[0]?.features.some((feature) => feature.name === "product.title"));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unresolved-object" && diagnostic.message.includes("resource"),
    ),
  );
  const browser: typeof import("../packages/check/src/browser.js") = await import(
    new URL("../dist/browser.js", import.meta.url).href
  );
  assert.deepEqual(await browser.checkTheme(new browser.MemoryThemeFileSystem(files)), result);
});

test("loop-carried assignments cover first and subsequent iterations without leaking the loop variable", async () => {
  const files = theme();
  files["sections/header.liquid"] = `{% assign carried=product %}{% assign item=collection %}
{% for item in product.variants %}{{carried.title}}{% assign carried=collection %}{{item.price}}{% endfor %}{{item.products}}`;
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages[0]?.features ?? [];
  for (const name of ["product.title", "collection.title", "variant.price", "collection.products"])
    assert.ok(
      features.some(
        (feature) =>
          feature.name === name &&
          feature.occurrences.some((occurrence) => occurrence.file === "sections/header.liquid"),
      ),
      name,
    );
  assert.ok(
    !features.some((feature) => ["collection.price", "variant.products"].includes(feature.name)),
  );
});

test("loop else assignments do not pollute the body or preserve overwritten entry bindings", async () => {
  const files = theme();
  files["sections/header.liquid"] = `{% assign value=product %}{% assign item=collection %}
{% for item in product.variants %}{{item.price}}{% assign value=collection %}
{% else %}{{item.products}}{% assign value=article %}{% endfor %}{{value.title}}`;
  const result = await checkTheme(new MemoryThemeFileSystem(files));
  const features = result.pages[0]?.features ?? [];
  for (const name of ["variant.price", "collection.products", "collection.title", "article.title"])
    assert.ok(features.some((feature) => feature.name === name));
  assert.ok(
    !features
      .find((feature) => feature.name === "product.title")
      ?.occurrences.some((occurrence) => occurrence.file === "sections/header.liquid"),
  );
  assert.ok(
    !features.some((feature) => ["variant.products", "collection.price"].includes(feature.name)),
  );
});
