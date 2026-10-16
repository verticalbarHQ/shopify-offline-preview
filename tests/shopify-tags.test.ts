import assert from "node:assert/strict";
import { test } from "node:test";
import { Liquid } from "liquidjs";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { objectTracker } from "../packages/data/src/objects.js";
import { renderTheme } from "../packages/render/src/index.js";
import { registerShopifyTags } from "../packages/render/src/shopify-tags.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

function engine(path = "/") {
  const engine = new Liquid();
  registerShopifyTags(engine, {
    path,
    track: objectTracker({
      read() {},
      unsupported(type, property) {
        throw new Error(`${type}.${property}`);
      },
    }),
    unsupported(message) {
      throw new Error(message);
    },
  });
  return engine;
}
test("initial forms evaluate scoped arguments, escape attributes, and restore surrounding form state", async () => {
  const source = `{% assign id='Chosen"id' %}{% form 'product', product, id: id, class: 'my form', data-example: 100 %}{{form.posted_successfully?}}|{{form.errors}}{% endform %}|{{form}}`;
  const output = await engine().parseAndRender(source, { product: { id: 42 }, form: "outer" });
  assert.match(
    output,
    /action="\/cart\/add" id="Chosen&quot;id" accept-charset="UTF-8" class="my form"/,
  );
  assert.match(output, /data-example="100"/);
  assert.match(output, /value="product".*value="✓".*false\|/);
  assert.match(output, /<input type="hidden" name="product-id" value="42" \/><\/form>\|outer$/);
  const newsletter = await engine().parseAndRender(
    `{% form 'customer', id:'Newsletter' %}signup{% endform %}`,
  );
  assert.match(newsletter, /action="\/contact#Newsletter" id="Newsletter"/);
  const local = await engine("/products/example?variant=7").parseAndRender(
    `{% form 'localization' %}locale{% endform %}`,
  );
  assert.match(local, /name="return_to" value="\/products\/example\?variant=7"/);
});
test("pagination slices loops without changing the source and keeps query parameters in links", async () => {
  const collection = {
    title: "Source",
    products: Array.from({ length: 7 }, (_, i) => ({ title: String(i + 1) })),
  };
  const source = `{% paginate collection.products by 3 %}{% for p in collection.products %}{{p.title}}{% endfor %}|{{paginate.current_offset}}/{{paginate.items}}/{{paginate.pages}}|{{paginate.previous.url}}|{{paginate.next.url}}{% endpaginate %}|{{collection.products.size}}`;
  assert.equal(
    await engine("/collections/example?page=2&sort_by=title-ascending").parseAndRender(source, {
      collection,
    }),
    "456|3/7/3|/collections/example?page=1&sort_by=title-ascending|/collections/example?page=3&sort_by=title-ascending|7",
  );
  assert.equal(collection.products.length, 7);
  assert.equal(
    await engine("/collections/example?page=4").parseAndRender(
      `{% paginate collection.products by 3 %}{{collection.products.size}}{% endpaginate %}`,
      { collection },
    ),
    "0",
  );
  for (const size of [0, 251])
    await assert.rejects(
      engine().parseAndRender(`{% paginate collection.products by ${size} %}x{% endpaginate %}`, {
        collection,
      }),
      /Pagination size/,
    );
  await assert.rejects(
    engine("/?page=25001").parseAndRender(
      `{% paginate collection.products by 1 %}x{% endpaginate %}`,
      { collection },
    ),
    /25,000/,
  );
});
test("pagination preserves Node/browser source reads and isolated snippet scopes", async () => {
  const theme = new MemoryThemeFileSystem({
    "layout/theme.liquid": "{{content_for_layout}}",
    "templates/collection.json": '{"sections":{"main":{"type":"main"}},"order":["main"]}',
    "sections/main.liquid": `{% paginate collection.products by 2 %}{{collection.title}}{% for p in collection.products %}{% render 'card', product: p %}{% endfor %}{% endpaginate %}`,
    "snippets/card.liquid": "{{product.title}}",
  });
  const result = await renderTheme(theme, "/collections/sop-catalog?page=2", {
    snapshot: defaultFixture(),
    inspect: true,
  });
  assert.ok(result.html.includes("SOP Product 03SOP Product 04"));
  assert.equal(result.diagnostics.length, 0);
  const section = result.tree[0]?.children[0];
  assert.ok(section);
  assert.ok(result.dataUsed[section.id]?.includes("collections[0].title"));
  assert.ok(Object.values(result.dataUsed).flat().includes("products[2].title"));
});
