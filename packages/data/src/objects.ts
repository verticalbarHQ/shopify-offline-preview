import type { Snapshot } from "./schema.js";

export type LiquidRecord = Record<string, unknown>;
export interface ObjectHooks {
  read(path: string): void;
  unsupported(type: string, property: string): void;
}
export interface RouteContext {
  pageType: string;
  path: string;
  variant: string | null;
  q: string;
  sortBy: string | null;
  resourceHandle: string | null;
  blogHandle?: string;
  designMode: boolean;
}

/** Shopify Liquid uses hundredths for JPY/KRW too. Values above safe numeric precision fail. */
export function liquidPrice(value: string): number {
  const [whole = "", fraction = ""] = value.split(".");
  if (!/^\d+(?:\.\d+)?$/.test(value) || /[1-9]/.test(fraction.slice(2)))
    throw new Error("Price cannot be represented in Liquid hundredths");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Price exceeds safe Liquid numeric precision");
  return Number(amount);
}
function id(value: string): number | string {
  const number = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(number) ? number : value;
}
function image(value: Snapshot["products"][number]["images"][number], index: number): LiquidRecord {
  const src = `/sop/images/${value.file.split("/").map(encodeURIComponent).join("/")}`;
  return {
    ...value,
    src,
    url: src,
    aspect_ratio: value.width / value.height,
    position: index + 1,
    media_type: "image",
    preview_image: { ...value, src, url: src, aspect_ratio: value.width / value.height },
  };
}

/** Source-backed fields plus explicit derivation; omitted fields are observed, never invented. */
export function liquidObjects(
  snapshot: Snapshot,
  route: RouteContext,
  hooks: ObjectHooks,
): LiquidRecord {
  const cache = new WeakMap<object, Map<string, object>>();
  const internal = new Set(["then", "toLiquid", "toJSON", "constructor", "__proto__", "prototype"]);
  function tracked<T extends object>(value: T, type: string, path: string): T {
    let entries = cache.get(value);
    if (!entries) {
      entries = new Map();
      cache.set(value, entries);
    }
    const cached = entries.get(`${type}:${path}`);
    // Cache keys identify the same object and wrapper type; Proxy<T> preserves T's shape.
    if (cached) return cached as T;
    const result = new Proxy(value, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (
          !descriptor &&
          typeof key === "string" &&
          !internal.has(key) &&
          !Array.isArray(target) &&
          !["settings", "dictionary", "metafields"].includes(type)
        )
          hooks.unsupported(type, key);
        return descriptor;
      },
      get(target, key, receiver) {
        if (typeof key !== "string") return Reflect.get(target, key, receiver);
        if (internal.has(key)) return undefined;
        if (Object.hasOwn(target, key)) {
          hooks.read(Array.isArray(target) ? `${path}[${key}]` : `${path}.${key}`);
          return Reflect.get(target, key, receiver);
        }
        if (Array.isArray(target) || ["settings", "dictionary", "metafields"].includes(type))
          return Reflect.get(target, key, receiver);
        // LiquidJS probes iterator/thenable properties directly; missing Liquid
        // properties are diagnosed by its own-property descriptor lookup above.
        return undefined;
      },
    });
    entries.set(`${type}:${path}`, result);
    return result;
  }
  const products = new Map<string, LiquidRecord>();
  const collections = new Map<string, LiquidRecord>();
  for (const [productIndex, source] of snapshot.products.entries()) {
    const path = `products[${productIndex}]`;
    const images = source.images.map(image);
    const variants = source.variants.map((variant, index) => {
      const options = source.options.map(
        (option) => variant.optionValues.find((value) => value.name === option.name)?.value ?? "",
      );
      const selected = variant.id === route.variant;
      return tracked(
        {
          id: id(variant.id),
          title: options.join(" / "),
          options,
          option1: options[0] ?? null,
          option2: options[1] ?? null,
          option3: options[2] ?? null,
          price: liquidPrice(variant.price),
          compare_at_price:
            variant.compareAtPrice === null ? null : liquidPrice(variant.compareAtPrice),
          available: variant.available,
          sku: variant.sku,
          barcode: variant.barcode,
          selected,
          url: `/products/${source.handle}?variant=${encodeURIComponent(variant.id)}`,
          image: images.find((i) => i.file === variant.image) ?? null,
          featured_image: images.find((i) => i.file === variant.image) ?? null,
        },
        "variant",
        `${path}.variants[${index}]`,
      );
    });
    const selected = variants.find((variant) => variant.selected);
    const firstAvailable = variants.find((variant) => variant.available) ?? null;
    const prices = source.variants.map((variant) => liquidPrice(variant.price));
    const comparePrices = source.variants.flatMap((variant) =>
      variant.compareAtPrice === null ? [] : [liquidPrice(variant.compareAtPrice)],
    );
    const dto: LiquidRecord = {
      handle: source.handle,
      title: source.title,
      description: source.descriptionHtml,
      content: source.descriptionHtml,
      vendor: source.vendor,
      type: source.productType,
      tags: source.tags,
      template_suffix: source.templateSuffix,
      url: `/products/${source.handle}`,
      available: source.variants.some((variant) => variant.available),
      price: Math.min(...prices),
      price_min: Math.min(...prices),
      price_max: Math.max(...prices),
      price_varies: new Set(prices).size > 1,
      compare_at_price: comparePrices.length ? Math.min(...comparePrices) : null,
      compare_at_price_min: comparePrices.length ? Math.min(...comparePrices) : null,
      compare_at_price_max: comparePrices.length ? Math.max(...comparePrices) : null,
      compare_at_price_varies: new Set(comparePrices).size > 1,
      variants,
      first_available_variant: firstAvailable,
      selected_variant: selected ?? null,
      selected_or_first_available_variant: selected ?? firstAvailable ?? variants[0] ?? null,
      has_only_default_variant:
        source.options.length === 1 &&
        source.options[0]?.name === "Title" &&
        source.options[0].values.length === 1 &&
        source.options[0].values[0] === "Default Title",
      options: source.options.map((option) => option.name),
      options_with_values: source.options.map((option, index) => ({
        name: option.name,
        position: index + 1,
        values: option.values,
        selected_value: (selected ?? firstAvailable ?? variants[0])?.options[index] ?? null,
      })),
      images,
      featured_image: images[0] ?? null,
      media: images,
      featured_media: images[0] ?? null,
      metafields: source.metafields,
    };
    products.set(source.handle, tracked(dto, "product", path));
  }
  for (const [collectionIndex, source] of snapshot.collections.entries()) {
    const members = source.products.flatMap((handle) => {
      const product = products.get(handle);
      return product ? [product] : [];
    });
    collections.set(
      source.handle,
      tracked(
        {
          handle: source.handle,
          title: source.title,
          description: source.descriptionHtml,
          url: `/collections/${source.handle}`,
          products: members,
          products_count: members.length,
          all_products_count: members.length,
          image: source.image ? image(source.image, 0) : null,
          template_suffix: source.templateSuffix,
          default_sort_by: source.sortOrder,
          sort_by: route.sortBy,
          filters: snapshot.filters,
        },
        "collection",
        `collections[${collectionIndex}]`,
      ),
    );
  }
  for (const source of snapshot.products) {
    const product = products.get(source.handle);
    if (product)
      Object.defineProperty(product, "collections", {
        enumerable: true,
        get: () =>
          [...collections.values()].filter((collection) =>
            snapshot.collections
              .find((c) => c.handle === collection.handle)
              ?.products.includes(source.handle),
          ),
      });
  }
  const pages = new Map(
    snapshot.pages.map((source, index) => [
      source.handle,
      tracked(
        {
          handle: source.handle,
          title: source.title,
          content: source.bodyHtml,
          url: `/pages/${source.handle}`,
          template_suffix: source.templateSuffix,
          metafields: source.metafields,
        },
        "page",
        `pages[${index}]`,
      ),
    ]),
  );
  const articles = new Map<string, Map<string, LiquidRecord>>();
  const blogs = new Map(
    snapshot.blogs.map((source, blogIndex) => [
      source.handle,
      tracked(
        {
          handle: source.handle,
          title: source.title,
          url: `/blogs/${source.handle}`,
          template_suffix: source.templateSuffix,
          articles: source.articles.map((article, index) => {
            const dto = tracked(
              {
                handle: article.handle,
                title: article.title,
                content: article.bodyHtml,
                excerpt: article.excerptHtml,
                author: article.author,
                published_at: article.publishedAt,
                image: article.image ? image(article.image, 0) : null,
                url: `/blogs/${source.handle}/${article.handle}`,
                tags: article.tags,
                template_suffix: article.templateSuffix,
                metafields: article.metafields,
              },
              "article",
              `blogs[${blogIndex}].articles[${index}]`,
            );
            let entries = articles.get(source.handle);
            if (!entries) {
              entries = new Map();
              articles.set(source.handle, entries);
            }
            entries.set(article.handle, dto);
            return dto;
          }),
          articles_count: source.articles.length,
        },
        "blog",
        `blogs[${blogIndex}]`,
      ),
    ]),
  );
  const menuMap = Object.fromEntries(
    snapshot.menus.map((menu) => [
      menu.handle,
      { handle: menu.handle, title: menu.title, links: menu.links },
    ]),
  );
  const globals: LiquidRecord = {
    shop: tracked(snapshot.shop, "shop", "shop"),
    all_products: tracked(Object.fromEntries(products), "dictionary", "all_products"),
    collections: tracked(Object.fromEntries(collections), "dictionary", "collections"),
    pages: tracked(Object.fromEntries(pages), "dictionary", "pages"),
    blogs: tracked(Object.fromEntries(blogs), "dictionary", "blogs"),
    linklists: tracked(menuMap, "dictionary", "linklists"),
    request: tracked(
      {
        path:
          route.pageType === "404" ? null : new URL(route.path, "https://offline.invalid").pathname,
        page_type: route.pageType,
        design_mode: route.designMode,
        locale: { iso_code: snapshot.shop.locale },
        host: snapshot.shop.domain,
        origin: `https://${snapshot.shop.domain}`,
      },
      "request",
      "request",
    ),
    routes: {
      root_url: "/",
      cart_url: "/cart",
      search_url: "/search",
      all_products_collection_url: "/collections/all",
    },
  };
  if (route.pageType === "product")
    globals.product = products.get(route.resourceHandle ?? "") ?? null;
  if (route.pageType === "collection")
    globals.collection =
      route.resourceHandle === "all"
        ? tracked(
            {
              handle: "all",
              products: [...products.values()],
              products_count: products.size,
              all_products_count: products.size,
              url: "/collections/all",
            },
            "collection",
            "collection",
          )
        : (collections.get(route.resourceHandle ?? "") ?? null);
  if (route.pageType === "page") globals.page = pages.get(route.resourceHandle ?? "") ?? null;
  if (route.pageType === "blog") globals.blog = blogs.get(route.resourceHandle ?? "") ?? null;
  if (route.pageType === "article") {
    const blog = blogs.get(route.blogHandle ?? "");
    globals.blog = blog ?? null;
    globals.article = articles.get(route.blogHandle ?? "")?.get(route.resourceHandle ?? "") ?? null;
  }
  return globals;
}
