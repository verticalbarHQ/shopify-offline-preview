import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultFixture } from "../packages/data/src/fixture.js";
import { renderTheme } from "../packages/render/src/index.js";
import { MemoryThemeFileSystem } from "../packages/theme/src/index.js";

const template = '{"layout":false,"sections":{"main":{"type":"main"}},"order":["main"]}';
const link = (title: string, url: string, type: string, links: unknown[] = []) => ({
  title,
  url,
  type,
  resourceHandle: null,
  links,
});

test("menu links derive current, active, child state, levels and their resource object", async () => {
  const snapshot = defaultFixture();
  snapshot.menus = [
    {
      handle: "main-menu",
      title: "Main menu",
      links: [
        link("Home", "/", "frontpage_link"),
        link("Shop", "/collections/all", "catalog_link", [
          link("Catalog", "/collections/sop-catalog", "collection_link", [
            link("Needle", "/products/sop-matrix-needle?variant=sop-main-2", "product_link"),
          ]),
        ]),
        link("Gone", "/pages/missing", "page_link"),
      ],
    },
  ] as typeof snapshot.menus;
  const theme = new MemoryThemeFileSystem({
    "templates/product.json": template,
    "sections/main.liquid":
      "{% assign menu = linklists['main-menu'] %}{{ menu.levels }}:{% for l in menu.links %}[{{ l.title }}|{{ l.current }}|{{ l.active }}|{{ l.child_current }}|{{ l.child_active }}|{{ l.levels }}|{{ l.object.title }}]{% for c in l.links %}({{ c.title }}|{{ c.current }}|{{ c.child_current }}|{{ c.levels }}|{{ c.object.title }}{% for g in c.links %}<{{ g.title }}|{{ g.current }}|{{ g.active }}|{{ g.levels }}|{{ g.object.title }}>{% endfor %}){% endfor %}{% endfor %}",
  });
  const result = await renderTheme(theme, "/products/sop-matrix-needle?variant=sop-main-7", {
    snapshot,
    inspect: true,
  });
  assert.ok(
    result.html.includes(
      "3:[Home|false|false|false|false|0|][Shop|false|false|true|true|2|]" +
        "(Catalog|false|true|1|Example Catalog<Needle|true|true|0|SOP Matrix Needle>)" +
        "[Gone|false|false|false|false|0|]",
    ),
    result.html,
  );
  assert.deepEqual(
    result.diagnostics.map((d) => `${d.code}: ${d.message}`),
    ["missing-resource: Menu link Gone references a resource absent from the snapshot."],
  );
  const reads = Object.values(result.dataUsed).flat();
  assert.ok(reads.includes("menus[0].links[1].links[0].links[0].title"), reads.join("\n"));
});

test("the home link is current only on the home page; handles derive from titles", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": template,
    "templates/page.json": template,
    "sections/main.liquid":
      "{% for l in linklists['main-menu'].links %}[{{ l.title }}:{{ l.current }}:{{ l.active }}]{% endfor %}",
  });
  let result = await renderTheme(theme, "/", { snapshot: defaultFixture() });
  assert.ok(result.html.includes("[Home:true:true][Catalog:false:false][About:false:false]"));
  result = await renderTheme(theme, "/pages/about", { snapshot: defaultFixture() });
  assert.ok(result.html.includes("[Home:false:false][Catalog:false:false][About:true:true]"));
  result = await renderTheme(
    new MemoryThemeFileSystem({
      "templates/index.json": template,
      "sections/main.liquid":
        "{% for l in linklists['main-menu'].links %}[{{ l.handle }}|{{ l.data_sharing_opt_out_icon | json }}]{% endfor %}",
    }),
    "/",
    { snapshot: defaultFixture() },
  );
  assert.ok(result.html.includes("[home|null][catalog|null][about|null]"), result.html);
  assert.deepEqual(result.diagnostics, []);
});

test("a menu prints as its handle, as a link_list setting passed to an attribute does", async () => {
  const theme = new MemoryThemeFileSystem({
    "templates/index.json": template,
    "sections/main.liquid":
      '<div data-menu="{{ section.settings.menu }}">{{ linklists.footer }}</div>{% schema %}{"name":"Main","settings":[{"type":"link_list","id":"menu","label":"Menu","default":"main-menu"}]}{% endschema %}',
  });
  const result = await renderTheme(theme, "/", { snapshot: defaultFixture(), inspect: true });
  assert.ok(result.html.includes('<div data-menu="main-menu">footer</div>'), result.html);
  assert.deepEqual(result.diagnostics, []);
});
