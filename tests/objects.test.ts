import assert from "node:assert/strict";
import { test } from "node:test";
import { Liquid } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { liquidObjects, liquidPrice } from "../packages/data/src/objects.js";
import { applyScenario } from "../packages/data/src/scenarios.js";

const route = {
  pageType: "product",
  path: "/",
  variant: null,
  q: "",
  sortBy: null,
  resourceHandle: "sop-matrix-needle",
  designMode: false,
};
const silent = { read() {}, unsupported() {} };

test("decimal prices convert exactly to hundredths and reject silent precision loss", () => {
  assert.equal(liquidPrice("12.34"), 1234);
  assert.equal(liquidPrice("1000"), 100000);
  assert.equal(liquidPrice("00012.3400"), 1234);
  for (const value of ["1.234", "-1", "1.2.3", "NaN", "9007199254740992"])
    assert.throws(() => liquidPrice(value), value);
});

test("product selection, prices, image URLs and sold-out fallback derive from source", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  const selected = product.variants.find((variant) => !variant.available);
  assert.ok(selected);
  const objects = liquidObjects(
    snapshot,
    { ...route, resourceHandle: product.handle, variant: selected.id },
    silent,
  );
  const engine = new Liquid();
  assert.equal(
    await engine.parseAndRender(
      "{{product.selected_variant.id}}|{{product.selected_or_first_available_variant.id}}|{{product.available}}",
      objects,
    ),
    `${selected.id}|${selected.id}|true`,
  );
  assert.equal(
    await engine.parseAndRender("{{product.price_min}}|{{product.price_max}}", objects),
    `${Math.min(...product.variants.map((v) => liquidPrice(v.price)))}|${Math.max(...product.variants.map((v) => liquidPrice(v.price)))}`,
  );
  const soldOut = applyScenario(snapshot, "sold-out");
  assert.equal(
    await engine.parseAndRender(
      "{% if product.first_available_variant == nil %}nil{% endif %}|{{product.selected_or_first_available_variant.id}}",
      liquidObjects(soldOut, { ...route, resourceHandle: product.handle }, silent),
    ),
    `nil|${product.variants[0]?.id}`,
  );
  assert.match(
    await engine.parseAndRender("{{product.featured_image.src}}", objects),
    /^\/sop\/images\//,
  );
});

test("Liquid's own-property check reports absent data and reads use indices without customer handles", async () => {
  const snapshot = defaultFixture();
  const product = snapshot.products[0];
  assert.ok(product);
  const reads: string[] = [];
  const unsupported: string[] = [];
  const before = JSON.stringify(snapshot);
  const objects = liquidObjects(
    snapshot,
    { ...route, resourceHandle: product.handle },
    {
      read: (path) => reads.push(path),
      unsupported: (type, property) => unsupported.push(`${type}.${property}`),
    },
  );
  assert.equal(
    await new Liquid().parseAndRender("{{product.title}}|{{product.id}}", objects),
    `${product.title}|`,
  );
  assert.ok(reads.includes("products[0].title"));
  assert.ok(unsupported.includes("product.id"));
  assert.ok(reads.every((path) => !path.includes(product.handle)));
  assert.equal(JSON.stringify(snapshot), before);
});

test("articles and product collection membership resolve without unsafe object casts", async () => {
  const snapshot = defaultFixture();
  const blog = snapshot.blogs[0];
  const article = blog?.articles[0];
  assert.ok(blog && article);
  const objects = liquidObjects(
    snapshot,
    { ...route, pageType: "article", blogHandle: blog.handle, resourceHandle: article.handle },
    silent,
  );
  assert.equal(
    await new Liquid().parseAndRender("{{blog.title}}|{{article.title}}", objects),
    `${blog.title}|${article.title}`,
  );
});

test("cart quantities and totals derive from actual variant prices, not compare-at sale prices", async () => {
  const snapshot = applyScenario(defaultFixture(), "with-items");
  const before = JSON.stringify(snapshot);
  const objects = liquidObjects(
    snapshot,
    { ...route, pageType: "cart", resourceHandle: null },
    silent,
  );
  const sum = snapshot.cart.lines.reduce((sum, line) => {
    const product = snapshot.products.find((p) => p.handle === line.productHandle);
    const variant = product?.variants.find((v) => v.id === line.variantId);
    assert.ok(variant);
    return sum + liquidPrice(variant.price) * line.quantity;
  }, 0);
  assert.equal(
    await new Liquid().parseAndRender(
      "{{cart.item_count}}|{{cart.total_price}}|{{cart.original_total_price}}|{{cart.total_discount}}|{{cart.note}}",
      objects,
    ),
    `3|${sum}|${sum}|0|Example cart note`,
  );
  assert.equal(
    await new Liquid().parseAndRender(
      "{% for item in cart.items %}{{item.quantity}}:{{item.final_price}}:{{item.variant.id}}|{% endfor %}",
      objects,
    ),
    snapshot.cart.lines
      .map((line) => {
        const p = snapshot.products.find((p) => p.handle === line.productHandle);
        const v = p?.variants.find((v) => v.id === line.variantId);
        assert.ok(v);
        return `${line.quantity}:${liquidPrice(v.price)}:${v.id}|`;
      })
      .join(""),
  );
  assert.equal(JSON.stringify(snapshot), before);
  const empty = liquidObjects(
    defaultFixture(),
    { ...route, pageType: "cart", resourceHandle: null },
    silent,
  );
  assert.equal(
    await new Liquid().parseAndRender(
      "{{cart.empty?}}|{{cart.items.size}}|{{cart.total_price}}",
      empty,
    ),
    "true|0|0",
  );
});
test("cart derivation refuses unsafe multiplication instead of losing monetary precision", () => {
  const snapshot = applyScenario(defaultFixture(), "with-items");
  const line = snapshot.cart.lines[0];
  assert.ok(line);
  line.quantity = Number.MAX_SAFE_INTEGER;
  assert.throws(() => liquidObjects(snapshot, route, silent), /Cart amount exceeds safe/);
});

test("search derives unambiguous product, page and article matches without fabricating records", async () => {
  const snapshot = defaultFixture();
  const before = JSON.stringify(snapshot);
  const unavailable: string[] = [];
  const make = (path: string) =>
    liquidObjects(
      snapshot,
      {
        ...route,
        pageType: "search",
        path,
        q: new URL(path, "https://offline.invalid").searchParams.get("q") ?? "",
        resourceHandle: null,
      },
      { read() {}, unsupported() {}, unsupportedOperation: (message) => unavailable.push(message) },
    );
  const liquid = new Liquid();
  assert.equal(
    await liquid.parseAndRender(
      "{{search.performed}}|{{search.results_count}}|{% for item in search.results %}{{item.object_type}}:{{item.title}}{% endfor %}",
      make("/search?q=Matrix%20Needle"),
    ),
    "true|1|product:SOP Matrix Needle",
  );
  assert.equal(
    await liquid.parseAndRender("{{search.results_count}}", make("/search?q=zzzxnevermatch983147")),
    "0",
  );
  assert.equal(await liquid.parseAndRender("{{search.performed}}", make("/search")), "false");
  assert.equal(
    await liquid.parseAndRender(
      "{% for item in search.results %}{{item.object_type}}{% endfor %}",
      make("/search?q=About%20Example&type=page"),
    ),
    "page",
  );
  assert.equal(
    await liquid.parseAndRender(
      "{% for item in search.results %}{{item.object_type}}{% endfor %}",
      make("/search?q=Example%20Story%201&type=article"),
    ),
    "article",
  );
  assert.equal(
    await liquid.parseAndRender("{{search.results_count}}", make("/search?q=Matrix%20Nee")),
    "1",
  );
  assert.equal(
    await liquid.parseAndRender(
      "{{search.results_count}}",
      make("/search?q=Matrix%20Nee&options[prefix]=none"),
    ),
    "0",
  );
  assert.equal(unavailable.length, 0);
  assert.equal(JSON.stringify(snapshot), before);
  await liquid.parseAndRender("{{search.results_count}}", make("/search?q=SOP"));
  assert.ok(unavailable.some((message) => message.includes("relevance ranking")));
  await liquid.parseAndRender("{{search.results_count}}", make("/search?q=tag:blue"));
  assert.ok(unavailable.some((message) => message.includes("operators")));
});
