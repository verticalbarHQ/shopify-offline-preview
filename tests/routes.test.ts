import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkMatrix, defaultFixture } from "../packages/data/src/fixture.js";
import { applyScenario } from "../packages/data/src/scenarios.js";
import { resolveRoute } from "../packages/render/src/routes.js";

test("routes resolve every benchmark case to the appropriate source resource and JSON template", () => {
  const fixture = defaultFixture();
  for (const item of benchmarkMatrix) {
    const result = resolveRoute(applyScenario(fixture, item.scenario), item.path);
    const expected = item.page === "home" ? "index" : item.page;
    assert.equal(result.pageType, expected, item.id);
    assert.equal(result.template, `templates/${expected}.json`, item.id);
  }
  assert.equal(resolveRoute(fixture, "/collections/all").resource?.kind, "all-collection");
  assert.equal(
    resolveRoute(fixture, "/collections/sop-catalog?page=2&sort_by=price-ascending").query.page,
    "2",
  );
  assert.equal(resolveRoute(fixture, "/search?q=Matrix%20Needle").query.q, "Matrix Needle");
});

test("alternate view overrides the resource suffix; malformed paths never escape theme files", () => {
  const fixture = defaultFixture();
  const product = fixture.products[0];
  assert.ok(product);
  product.templateSuffix = "details";
  assert.equal(
    resolveRoute(fixture, `/products/${product.handle}`).template,
    "templates/product.details.json",
  );
  assert.equal(
    resolveRoute(fixture, `/products/${product.handle}?view=compact`).template,
    "templates/product.compact.json",
  );
  for (const path of [
    "https://example.test",
    "//example.test",
    "/products/example?view=../../secret",
    "/products\\example",
  ])
    assert.throws(() => resolveRoute(fixture, path));
  assert.equal(resolveRoute(fixture, "/products/%2fsecret").pageType, "404");
});

test("unknown paths/resources render 404 while preserving explicit missing-resource diagnostics", () => {
  const fixture = defaultFixture();
  assert.equal(resolveRoute(fixture, "/missing").pageType, "404");
  const missing = resolveRoute(fixture, "/products/missing");
  assert.equal(missing.pageType, "404");
  assert.equal(missing.resource, null);
  assert.equal(missing.diagnostics[0]?.code, "missing-resource");
  assert.equal(resolveRoute(fixture, "/blogs/news/missing").pageType, "404");
});
