import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseJsonc } from "jsonc-parser";
import { type DefaultTreeAdapterTypes, parseFragment } from "parse5";
import { checkSchema } from "../../packages/check/src/contracts.js";
import { type RenderResult, renderSchema } from "../../packages/render/src/contracts.js";

/** Paths the checks use. None of them is inside the agent's workspace. */
export interface Context {
  /** dist/cli.js of a separate, untouched install of the package under test. */
  cli: string;
  /** The package's bundled sample store. */
  fixture: string;
  /** The pinned Dawn theme the workspace copy was made from. */
  sourceTheme: string;
}

export interface Task {
  id: string;
  prompt: string;
  /** Changes the fresh workspace before the agent starts. */
  setup?: (dir: string, context: Context) => Promise<void>;
  /** Returns the reason the task failed, or undefined when it passed. */
  check: (dir: string, context: Context) => Promise<string | undefined>;
  /** A known-good solution, used by the self-test to prove the check can pass. */
  reference: (dir: string, context: Context) => Promise<void>;
}

const product = "/products/sop-matrix-needle";

function render(context: Context, theme: string, path: string, extra: string[] = []) {
  const run = spawnSync(
    process.execPath,
    [context.cli, "render", theme, path, "--json", ...extra],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  if (run.status !== 0) return { error: `render ${path} exited ${run.status}` } as const;
  return { result: renderSchema.parse(JSON.parse(run.stdout)) } as const;
}

const unseen = new Set(["head", "title", "script", "style", "template", "noscript"]);
/** Whether markup alone hides the element. Styles from theme stylesheets are not evaluated. */
function hidden(element: DefaultTreeAdapterTypes.Element): boolean {
  const attribute = (name: string) => element.attrs.find((item) => item.name === name)?.value;
  const classes = (attribute("class") ?? "").split(/\s+/);
  return (
    unseen.has(element.tagName) ||
    attribute("hidden") !== undefined ||
    attribute("aria-hidden") === "true" ||
    /display\s*:\s*none|visibility\s*:\s*hidden/.test(attribute("style") ?? "") ||
    classes.includes("hidden") ||
    classes.includes("visually-hidden")
  );
}
/** The text a shopper sees, skipping elements that the markup hides. */
function visibleText(html: string): string {
  const parts: string[] = [];
  const walk = (node: DefaultTreeAdapterTypes.ParentNode) => {
    for (const child of node.childNodes) {
      if (child.nodeName === "#text") parts.push((child as DefaultTreeAdapterTypes.TextNode).value);
      else if ("tagName" in child && !hidden(child)) walk(child);
    }
  };
  walk(parseFragment(html));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** The HTML of the section whose wrapper id matches, up to the next section wrapper. */
function sectionHtml(html: string, id: RegExp): string | undefined {
  const start = html.search(id);
  if (start < 0) return undefined;
  const next = html.indexOf('id="shopify-section-', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}
const mainSection = /id="shopify-section-template--[^"]*__main"/;
const templateSection = (key: string) =>
  new RegExp(`id="shopify-section-template--[^"]*__${key.replace(/[^\w-]/g, "\\$&")}"`);

function liquidErrors(result: RenderResult): number {
  return result.diagnostics.filter((item) => item.code === "liquid-error").length;
}

function sections(result: RenderResult): RenderResult["tree"] {
  const out: RenderResult["tree"] = [];
  const walk = (nodes: RenderResult["tree"]) => {
    for (const node of nodes) {
      if (node.kind === "section") out.push(node);
      walk(node.children);
    }
  };
  walk(result.tree);
  return out;
}

async function files(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out.set(
      relative(root, path),
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    );
  }
  return out;
}

async function themeUnchanged(dir: string, context: Context): Promise<string | undefined> {
  const [before, after] = [await files(context.sourceTheme), await files(join(dir, "theme"))];
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  );
  return changed.length ? `the theme was changed: ${changed.slice(0, 3).join(", ")}` : undefined;
}

async function readJson(path: string): Promise<unknown> {
  return parseJsonc(await readFile(path, "utf8"));
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value as JsonObject;

/** Calls use with a copy of the sample store that has one change, then removes the copy. */
async function withSample<T>(
  context: Context,
  change: (snapshot: JsonObject) => void,
  use: (data: string) => T,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "sop-agent-eval-data-"));
  try {
    const data = join(root, "data");
    await cp(context.fixture, data, { recursive: true });
    const snapshot = object(await readJson(join(data, "snapshot.json")));
    change(snapshot);
    await writeJson(join(data, "snapshot.json"), snapshot);
    return use(data);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const products = (snapshot: JsonObject) => snapshot.products as JsonObject[];
const byHandle = (snapshot: JsonObject, handle: string) => {
  const found = products(snapshot).find((item) => item.handle === handle);
  if (!found) throw new Error(`no product ${handle}`);
  return found;
};

/** Text of the main product section before the product title heading. */
function textAboveTitle(result: RenderResult): string | undefined {
  const main = sectionHtml(result.html, mainSection);
  const title = main?.indexOf("<h1") ?? -1;
  return main && title >= 0 ? visibleText(main.slice(0, title)) : undefined;
}

async function editProductTemplate(dir: string, change: (template: JsonObject) => void) {
  const path = join(dir, "theme/templates/product.json");
  const template = object(await readJson(path));
  change(template);
  await writeJson(path, template);
}

async function serverOnlyTruth(context: Context): Promise<string[]> {
  const run = spawnSync(process.execPath, [context.cli, "check", context.sourceTheme, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const page = checkSchema
    .parse(JSON.parse(run.stdout))
    .pages.find((item) => item.template === "templates/product.json");
  if (!page) throw new Error("check reported no product template");
  return [
    ...new Set(page.features.filter((item) => item.serverOnly).map((item) => item.name)),
  ].sort();
}

function homeSectionsTruth(context: Context): string[] {
  const rendered = render(context, context.sourceTheme, "/");
  if (!rendered.result) throw new Error(rendered.error);
  return sections(rendered.result).map((node) => node.type);
}

const items = ["Free returns", "Secure checkout", "Fast delivery"];

export const tasks: Task[] = [
  {
    id: "product-type-above-title",
    prompt:
      "On product pages, show the product's type (for example “Test Goods”) directly above the product title. It must come from the product's data, not be typed into the theme.",
    async check(dir, context) {
      const rendered = render(context, join(dir, "theme"), product);
      if (!rendered.result) return rendered.error;
      if (!/Test Goods/.test(textAboveTitle(rendered.result) ?? ""))
        return "the product type is not shown above the title";
      const changed = await withSample(
        context,
        (snapshot) => {
          byHandle(snapshot, "sop-matrix-needle").productType = "Checker Kind";
        },
        (data) => render(context, join(dir, "theme"), product, ["--data", data]),
      );
      if (!changed.result) return changed.error;
      if (!/Checker Kind/.test(textAboveTitle(changed.result) ?? ""))
        return "the text above the title does not follow the product's type";
      return undefined;
    },
    async reference(dir) {
      await editProductTemplate(dir, (template) => {
        const main = object(object(template.sections).main);
        object(main.blocks).product_type = {
          type: "text",
          settings: { text: "{{ product.type }}", text_style: "subtitle" },
        };
        const order = main.block_order as string[];
        order.splice(order.indexOf("title"), 0, "product_type");
      });
    },
  },
  {
    id: "announcement-text",
    prompt: "Change the announcement bar message to “Free shipping on orders over $50”.",
    async check(dir, context) {
      const rendered = render(context, join(dir, "theme"), "/");
      if (!rendered.result) return rendered.error;
      const text = visibleText(rendered.result.html);
      if (!text.includes("Free shipping on orders over $50")) return "the new message is not shown";
      if (text.includes("Welcome to our store")) return "the old message is still shown";
      return undefined;
    },
    async reference(dir) {
      const path = join(dir, "theme/sections/header-group.json");
      const source = await readFile(path, "utf8");
      await writeFile(
        path,
        source.replace("Welcome to our store", "Free shipping on orders over $50"),
      );
    },
  },
  {
    id: "trust-badges-section",
    prompt:
      "Create a new section file and add it to product pages, directly after the main product section. It shows the heading “Why shop with us” and three items: “Free returns”, “Secure checkout” and “Fast delivery”. Make each item a block in the new section's schema, so a merchant can edit, add or remove items in the theme editor.",
    async check(dir, context) {
      const rendered = render(context, join(dir, "theme"), product);
      if (!rendered.result) return rendered.error;
      const original = await files(join(context.sourceTheme, "sections"));
      const template = sections(rendered.result).filter((node) =>
        node.settingsPath?.startsWith("templates/product.json#/sections/"),
      );
      const main = template.findIndex((node) => node.type === "main-product");
      const added = template[main + 1];
      if (main < 0 || !added) return "no section follows the main product section";
      if (original.has(`${added.type}.liquid`))
        return `the section after the main product is the existing ${added.type}`;
      if (added.children.filter((node) => node.kind === "block").length < 3)
        return "the new section does not render three blocks";
      const key = added.settingsPath?.split("/").at(-1) ?? "";
      const text = visibleText(sectionHtml(rendered.result.html, templateSection(key)) ?? "");
      const heading = text.indexOf("Why shop with us");
      if (heading < 0) return "the new section does not show the heading";
      for (const item of items)
        if (text.indexOf(item, heading) < 0) return `the new section does not show “${item}”`;
      // Editing the blocks in the template must change the items the section shows.
      const copy = await mkdtemp(join(tmpdir(), "sop-agent-eval-theme-"));
      try {
        await cp(join(dir, "theme"), copy, { recursive: true });
        const path = join(copy, "templates/product.json");
        const template = object(await readJson(path));
        const blocks = object(object(object(template.sections)[key]).blocks ?? {});
        let edited = 0;
        for (const block of Object.values(blocks)) {
          const settings = object(object(block).settings ?? {});
          for (const [name, value] of Object.entries(settings)) {
            const index = items.indexOf(String(value));
            if (index >= 0) {
              settings[name] = `Eval item ${index}`;
              edited += 1;
            }
          }
        }
        if (edited < 3) return "the items are not settings of the section's blocks";
        await writeJson(path, template);
        const changed = render(context, copy, product);
        if (!changed.result) return changed.error;
        const shown = visibleText(sectionHtml(changed.result.html, templateSection(key)) ?? "");
        if (![0, 1, 2].every((index) => shown.includes(`Eval item ${index}`)))
          return "editing the blocks does not change the items shown";
      } finally {
        await rm(copy, { recursive: true, force: true });
      }
      return undefined;
    },
    async reference(dir) {
      await writeFile(
        join(dir, "theme/sections/trust-badges.liquid"),
        `<div class="page-width">
  <h2>{{ section.settings.heading | escape }}</h2>
  <ul>
    {%- for block in section.blocks -%}
      <li {{ block.shopify_attributes }}>{{ block.settings.text | escape }}</li>
    {%- endfor -%}
  </ul>
</div>

{% schema %}
{
  "name": "Trust badges",
  "settings": [{ "type": "text", "id": "heading", "label": "Heading", "default": "Why shop with us" }],
  "blocks": [{ "type": "item", "name": "Item", "settings": [{ "type": "text", "id": "text", "label": "Text" }] }],
  "presets": [{ "name": "Trust badges" }]
}
{% endschema %}
`,
      );
      await editProductTemplate(dir, (template) => {
        object(template.sections).trust_badges = {
          type: "trust-badges",
          settings: { heading: "Why shop with us" },
          blocks: Object.fromEntries(
            items.map((text, index) => [`item_${index}`, { type: "item", settings: { text } }]),
          ),
          block_order: items.map((_, index) => `item_${index}`),
        };
        const order = template.order as string[];
        order.splice(order.indexOf("main") + 1, 0, "trust_badges");
      });
    },
  },
  {
    id: "fix-liquid-error",
    prompt:
      "The product page shows a Liquid error. Find the cause and fix it, so the page renders as the theme intends.",
    async setup(dir) {
      const path = join(dir, "theme/sections/main-product.liquid");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace("render 'price'", "rendr 'price'"),
      );
    },
    async check(dir, context) {
      const rendered = render(context, join(dir, "theme"), product);
      if (!rendered.result) return rendered.error;
      if (liquidErrors(rendered.result)) return "the product page still has a Liquid error";
      const main = sectionHtml(rendered.result.html, mainSection) ?? "";
      if (!main.includes("<h1")) return "the product title is missing";
      if (!/USD 12\.50/.test(visibleText(main))) return "the product price is missing";
      return undefined;
    },
    async reference(dir) {
      const path = join(dir, "theme/sections/main-product.liquid");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace("rendr 'price'", "render 'price'"),
      );
    },
  },
  {
    id: "new-product-data",
    prompt:
      "Create store data for the preview in ./data, starting from the tool's bundled sample store. Add a product titled “Test Hoodie” with the handle test-hoodie, the vendor “Example Studio”, one variant priced 49.00 and no images. The page /products/test-hoodie must render with this data, and the sample store's products must still be there.",
    async check(dir, context) {
      const data = ["--data", join(dir, "data")];
      const rendered = render(context, join(dir, "theme"), "/products/test-hoodie", data);
      if (!rendered.result) return rendered.error;
      if (rendered.result.route.pageType !== "product")
        return "/products/test-hoodie is not a product page";
      const main = visibleText(sectionHtml(rendered.result.html, mainSection) ?? "");
      for (const text of ["Test Hoodie", "USD 49.00", "Example Studio"])
        if (!main.includes(text)) return `the product page does not show “${text}”`;
      const snapshot = object(await readJson(join(dir, "data/snapshot.json")));
      const original = object(await readJson(join(context.fixture, "snapshot.json")));
      const handles = new Set(products(snapshot).map((item) => item.handle));
      if (!products(original).every((item) => handles.has(item.handle)))
        return "some of the sample store's products are gone";
      const hoodie = byHandle(snapshot, "test-hoodie");
      if ((hoodie.variants as unknown[]).length !== 1)
        return "the product does not have one variant";
      if (((hoodie.images as unknown[] | undefined) ?? []).length) return "the product has images";
      return undefined;
    },
    async reference(dir, context) {
      await cp(context.fixture, join(dir, "data"), { recursive: true });
      const path = join(dir, "data/snapshot.json");
      const snapshot = object(await readJson(path));
      const base = structuredClone(byHandle(snapshot, "sop-product-02"));
      const variant = object((base.variants as unknown[])[0]);
      products(snapshot).push({
        ...base,
        id: "109999",
        handle: "test-hoodie",
        title: "Test Hoodie",
        vendor: "Example Studio",
        images: [],
        variants: [{ ...variant, id: "test-hoodie-1", sku: "TH-1", price: "49.00", image: null }],
      });
      await writeJson(path, snapshot);
    },
  },
  {
    id: "sale-scenario",
    prompt:
      "The store data in ./data defines scenarios. Add a scenario named “sale” in which the product sop-product-02 has a compare-at price of 30.00, so its product page shows it on sale. Without the scenario the data must stay as it is.",
    async setup(dir, context) {
      await cp(context.fixture, join(dir, "data"), { recursive: true });
    },
    async check(dir, context) {
      const theme = join(dir, "theme");
      const data = ["--data", join(dir, "data")];
      const sale = render(context, theme, "/products/sop-product-02", [
        ...data,
        "--scenario",
        "sale",
      ]);
      if (!sale.result) return sale.error;
      const main = sectionHtml(sale.result.html, mainSection) ?? "";
      if (!main.includes("price--on-sale")) return "the product is not on sale in the scenario";
      if (!visibleText(main).includes("USD 30.00")) return "the compare-at price is not shown";
      const plain = render(context, theme, "/products/sop-product-02", data);
      if (!plain.result) return plain.error;
      if ((sectionHtml(plain.result.html, mainSection) ?? "").includes("price--on-sale"))
        return "the product is on sale without the scenario";
      const snapshot = object(await readJson(join(dir, "data/snapshot.json")));
      const original = object(await readJson(join(context.fixture, "snapshot.json")));
      const { sale: _, ...scenarios } = object(snapshot.scenarios);
      if (!isDeepStrictEqual({ ...snapshot, scenarios }, original))
        return "the data outside the new scenario was changed";
      return undefined;
    },
    async reference(dir) {
      const path = join(dir, "data/snapshot.json");
      const snapshot = object(await readJson(path));
      // Scenarios are JSON merge patches, which replace arrays whole.
      const patched = structuredClone(products(snapshot));
      const variant = object(
        (byHandle({ products: patched }, "sop-product-02").variants as unknown[])[0],
      );
      variant.compareAtPrice = "30.00";
      object(snapshot.scenarios).sale = { products: patched };
      await writeJson(path, snapshot);
    },
  },
  {
    id: "add-to-cart-label",
    prompt:
      "Change the “Add to cart” button text to “Add to bag” everywhere in the theme, through the theme's English translations rather than in the templates.",
    async check(dir, context) {
      const rendered = render(context, join(dir, "theme"), product);
      if (!rendered.result) return rendered.error;
      const main = visibleText(sectionHtml(rendered.result.html, mainSection) ?? "");
      if (!main.includes("Add to bag")) return "the product page button does not say “Add to bag”";
      if (main.includes("Add to cart")) return "the product page still says “Add to cart”";
      const locale = object(await readJson(join(dir, "theme/locales/en.default.json")));
      if (object(object(locale.products).product).add_to_cart !== "Add to bag")
        return "the English translation was not changed";
      return undefined;
    },
    async reference(dir) {
      const path = join(dir, "theme/locales/en.default.json");
      const locale = object(await readJson(path));
      object(object(locale.products).product).add_to_cart = "Add to bag";
      await writeJson(path, locale);
    },
  },
  {
    id: "home-section-order",
    prompt:
      "Without changing the theme, find out which sections render on the home page, from top to bottom, including the header and footer groups. Write their section file names without the .liquid extension (for example “header”), one per line, to answer.txt in this folder.",
    async check(dir, context) {
      const unchanged = await themeUnchanged(dir, context);
      if (unchanged) return unchanged;
      const answer = await readFile(join(dir, "answer.txt"), "utf8").catch(() => undefined);
      if (answer === undefined) return "answer.txt is missing";
      const lines = answer
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const truth = homeSectionsTruth(context);
      return lines.join(",") === truth.join(",")
        ? undefined
        : `answer ${lines.join(",")} differs from ${truth.join(",")}`;
    },
    async reference(dir, context) {
      await writeFile(join(dir, "answer.txt"), `${homeSectionsTruth(context).join("\n")}\n`);
    },
  },
  {
    id: "server-only-features",
    prompt:
      "Without changing the theme, use the preview tool to find which Shopify features (filters, tags, objects or properties) used by the product page template are reported as server-only, meaning only Shopify's servers can produce them. Write their names as a JSON array, sorted alphabetically and without duplicates, to answer.json in this folder.",
    async check(dir, context) {
      const unchanged = await themeUnchanged(dir, context);
      if (unchanged) return unchanged;
      const answer = await readJson(join(dir, "answer.json")).catch(() => undefined);
      if (!Array.isArray(answer)) return "answer.json is missing or not a JSON array";
      const truth = await serverOnlyTruth(context);
      const given = [...new Set(answer.map(String))].sort();
      return given.join(",") === truth.join(",")
        ? undefined
        : `answer has ${given.length} names, expected ${truth.length}: missing ${truth.filter((name) => !given.includes(name)).join(", ") || "none"}; extra ${given.filter((name) => !truth.includes(name)).join(", ") || "none"}`;
    },
    async reference(dir, context) {
      await writeJson(join(dir, "answer.json"), await serverOnlyTruth(context));
    },
  },
  {
    id: "article-iso-date",
    prompt:
      "On blog article pages, show the publish date as year-month-day, for example 2026-10-13, instead of the current long format.",
    async check(dir, context) {
      const path = "/blogs/news/story-1";
      const rendered = render(context, join(dir, "theme"), path);
      if (!rendered.result) return rendered.error;
      const text = visibleText(sectionHtml(rendered.result.html, mainSection) ?? "");
      if (!text.includes("2026-10-13")) return "the article does not show 2026-10-13";
      if (text.includes("October 13, 2026")) return "the long date is still shown";
      const changed = await withSample(
        context,
        (snapshot) => {
          const blog = (snapshot.blogs as JsonObject[])[0] as JsonObject;
          object((blog.articles as unknown[])[0]).publishedAt = "2025-03-04T12:00:00Z";
        },
        (data) => render(context, join(dir, "theme"), path, ["--data", data]),
      );
      if (!changed.result) return changed.error;
      if (!visibleText(sectionHtml(changed.result.html, mainSection) ?? "").includes("2025-03-04"))
        return "the date does not follow the article's publish date";
      return undefined;
    },
    async reference(dir) {
      const path = join(dir, "theme/sections/main-article.liquid");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(
          "article.published_at | time_tag: format: 'date'",
          "article.published_at | date: '%Y-%m-%d'",
        ),
      );
    },
  },
];
