import type { LiquidRecord } from "../../data/src/objects.js";
import type { Snapshot } from "../../data/src/schema.js";
import translations from "../../spec/src/generated/translations.json" with { type: "json" };
import type { ResolvedRoute } from "./routes.js";

interface Hooks {
  read(path: string): void;
  unsupported(message: string): void;
  /** Metadata the snapshot does not supply. */
  missing(message: string): void;
  /** The snapshot image as a Liquid image object. */
  image(value: NonNullable<Snapshot["shop"]["socialSharingImage"]>, path: string): unknown;
}
const titles: Readonly<Record<string, string>> = translations;
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
export function registerPageMetadata(
  globals: LiquidRecord,
  snapshot: Snapshot,
  route: ResolvedRoute,
  hooks: Hooks,
): void {
  let source: { title: string; seo?: Snapshot["shop"]["seo"] } | undefined;
  let path = "";
  const handle = route.resource?.handle;
  if (route.pageType === "article") {
    const blog = snapshot.blogs.findIndex((value) => value.handle === route.resource?.blogHandle);
    const article =
      snapshot.blogs[blog]?.articles.findIndex((value) => value.handle === handle) ?? -1;
    source = snapshot.blogs[blog]?.articles[article];
    path = `blogs[${blog}].articles[${article}]`;
  } else if (route.resource && route.resource.kind !== "all-collection") {
    const resources =
      route.pageType === "product"
        ? snapshot.products
        : route.pageType === "collection"
          ? snapshot.collections
          : route.pageType === "page"
            ? snapshot.pages
            : snapshot.blogs;
    const index = resources.findIndex((value) => value.handle === handle);
    source = resources[index];
    path = `${route.pageType === "product" ? "products" : route.pageType === "collection" ? "collections" : route.pageType === "page" ? "pages" : "blogs"}[${index}]`;
  }
  function title(
    seo: Snapshot["shop"]["seo"],
    fallback: string,
    prefix: string,
    field: string,
  ): string {
    if (seo?.title === undefined)
      hooks.missing(
        `SEO title metadata for ${prefix} is absent from the snapshot; the source ${field} is used.`,
      );
    else hooks.read(`${prefix}.seo.title`);
    if (seo?.title) return escapeHtml(seo.title);
    hooks.read(`${prefix}.${field}`);
    return escapeHtml(fallback);
  }
  function system(key: string, args: Record<string, string | number> = {}): string {
    hooks.read("shop.locale");
    if (snapshot.shop.locale.split("-")[0] !== "en")
      hooks.unsupported(
        "Localized system page titles are not available for this locale; English is used.",
      );
    return escapeHtml(
      (titles[`shopify.page_titles.${key}`] ?? "").replace(/%\{(\w+)\}/g, (_whole, name: string) =>
        String(args[name] ?? ""),
      ),
    );
  }
  Object.defineProperty(globals, "page_title", {
    get() {
      if (source) return title(source.seo, source.title, path, "title");
      if (route.pageType === "index")
        return title(snapshot.shop.seo, snapshot.shop.name, "shop", "name");
      if (route.pageType === "cart") return system("shopping_cart");
      if (route.pageType === "collection") return system("products");
      if (route.pageType === "search") {
        if (!route.query.q.trim()) return system("search");
        const search = globals.search;
        const count =
          search && typeof search === "object" && "results_count" in search
            ? Number(search.results_count)
            : 0;
        return system(`search_results.${count === 1 ? "one" : "other"}`, {
          count,
          terms: route.query.q,
        });
      }
      return system("not_found");
    },
  });
  Object.defineProperty(globals, "canonical_url", {
    enumerable: true,
    get() {
      // Query parameters other than pagination select views of the same canonical page.
      hooks.read("shop.domain");
      const url = new URL(route.path, "https://offline.invalid");
      const page = Number(route.query.page ?? 1);
      const pathname = url.pathname.replace(/(.)\/$/, "$1");
      return `https://${snapshot.shop.domain}${pathname}${Number.isInteger(page) && page > 1 ? `?page=${page}` : ""}`;
    },
  });
  Object.defineProperty(globals, "page_image", {
    enumerable: true,
    get() {
      const resource =
        route.pageType === "product"
          ? globals.product
          : route.pageType === "collection"
            ? globals.collection
            : route.pageType === "article"
              ? globals.article
              : null;
      const image =
        resource !== null && typeof resource === "object"
          ? Reflect.get(resource, route.pageType === "product" ? "featured_image" : "image")
          : null;
      if (image) return image;
      const sharing = snapshot.shop.socialSharingImage;
      if (sharing) return hooks.image(sharing, "shop.socialSharingImage");
      if (sharing === null) {
        hooks.read("shop.socialSharingImage");
        return null;
      }
      hooks.missing(
        "The shop's social sharing image is absent from the snapshot; page_image is nil.",
      );
      return null;
    },
  });
  Object.defineProperty(globals, "page_description", {
    get() {
      if (source) {
        if (source.seo?.description !== undefined) {
          hooks.read(`${path}.seo.description`);
          return source.seo.description;
        }
        hooks.missing(`Resolved SEO description for ${path} is absent from the snapshot.`);
        return null;
      }
      if (route.pageType === "index" || route.pageType === "search") {
        if (snapshot.shop.seo?.description !== undefined) {
          hooks.read("shop.seo.description");
          return snapshot.shop.seo.description;
        }
        if (snapshot.shop.description !== undefined) {
          hooks.read("shop.description");
          return snapshot.shop.description;
        }
        hooks.missing("Resolved SEO description for shop is absent from the snapshot.");
      }
      return null;
    },
  });
}
