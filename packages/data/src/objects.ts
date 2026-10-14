import { Drop } from "liquidjs";
import { ImageDirectory } from "./images.js";
import type { Snapshot } from "./schema.js";
import { type SearchCandidate, searchResults } from "./search.js";

export type LiquidRecord = Record<string, unknown>;
const objectKinds = new WeakMap<object, string>();
export function liquidObjectKind(value: unknown): string | undefined {
  return value !== null && typeof value === "object" ? objectKinds.get(value) : undefined;
}
export function preserveLiquidObjectKind(source: unknown, target: object): void {
  const kind = liquidObjectKind(source);
  if (kind !== undefined) objectKinds.set(target, kind);
}
export interface ObjectHooks {
  read(path: string): void;
  unsupported(type: string, property: string): void;
  unsupportedOperation?(message: string): void;
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
function availableFields(values: LiquidRecord): LiquidRecord {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
function image(
  value: Snapshot["products"][number]["images"][number],
  index: number | null = null,
): LiquidRecord {
  const src = `/sop/images/${value.file.split("/").map(encodeURIComponent).join("/")}`;
  return {
    file: value.file,
    alt: value.alt,
    width: value.width,
    height: value.height,
    ...(value.id === undefined ? {} : { id: value.id === null ? null : id(value.id) }),
    src,
    url: src,
    aspect_ratio: value.width / value.height,
    position: index === null ? null : index + 1,
    product_id: null,
    variants: null,
    "attached_to_variant?": null,
    media_type: null,
    preview_image: null,
  };
}

/** Source-backed fields plus explicit derivation; omitted fields are observed, never invented. */
export function liquidObjects(
  snapshot: Snapshot,
  route: RouteContext,
  hooks: ObjectHooks,
): LiquidRecord {
  const cache = new WeakMap<object, Map<string, object>>();
  const internal = new Set([
    "next", // LiquidJS probes this descriptor when resolving generator results.
    "then",
    "toLiquid",
    "toJSON",
    "constructor",
    "__proto__",
    "prototype",
    "equals", // LiquidJS probes its public Comparable protocol during comparisons.
    "gt",
    "geq",
    "lt",
    "leq",
  ]);
  function tracked<T extends object>(
    value: T,
    type: string,
    path: string,
    sourceKeys?: Readonly<Record<string, string | null>>,
  ): T {
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
          const source = sourceKeys && Object.hasOwn(sourceKeys, key) ? sourceKeys[key] : key;
          if (source !== null)
            hooks.read(Array.isArray(target) ? `${path}[${source}]` : `${path}.${source}`);
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
    objectKinds.set(result, type);
    return result;
  }
  function trackedJson(value: unknown, type: string, path: string): unknown {
    if (Array.isArray(value))
      return tracked(
        value.map((item, index) => trackedJson(item, type, `${path}[${index}]`)),
        type,
        path,
      );
    if (value !== null && typeof value === "object")
      return tracked(
        Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            trackedJson(item, type, `${path}.${key}`),
          ]),
        ),
        type,
        path,
      );
    return value;
  }
  const products = new Map<string, LiquidRecord>();
  const collections = new Map<string, LiquidRecord>();
  const sortOptions = [
    ["manual", "Featured"],
    ["most-relevant", "Most relevant"],
    ["best-selling", "Best selling"],
    ["title-ascending", "Alphabetically, A-Z"],
    ["title-descending", "Alphabetically, Z-A"],
    ["price-ascending", "Price, low to high"],
    ["price-descending", "Price, high to low"],
    ["created-ascending", "Date, old to new"],
    ["created-descending", "Date, new to old"],
  ].map(([value, name]) => ({ value, name }));
  function collectionSortOptions(supplied?: Snapshot["collections"][number]["sortOptions"]) {
    if (supplied) return supplied;
    if (snapshot.shop.locale.split("-")[0] !== "en")
      hooks.unsupportedOperation?.(
        "Localized collection sort labels are missing; English is used.",
      );
    return sortOptions;
  }
  for (const [productIndex, source] of snapshot.products.entries()) {
    const path = `products[${productIndex}]`;
    const images = source.images.map((value, index) =>
        tracked(image(value, index), "image", `${path}.images[${index}]`),
      ),
      media = source.images.map((value, index) => {
        const preview = tracked(
            {
              ...image(value),
              id: null,
              alt:
                value.previewAlt === undefined
                  ? value.mediaAlt === undefined
                    ? value.alt
                    : value.mediaAlt
                  : value.previewAlt,
            },
            "image",
            `${path}.images[${index}]`,
            {
              id: null,
              alt:
                value.previewAlt !== undefined
                  ? "previewAlt"
                  : value.mediaAlt !== undefined
                    ? "mediaAlt"
                    : "alt",
            },
          ),
          record = image(value, index);
        delete record.id;
        if (value.mediaId !== undefined) record.id = id(value.mediaId);
        record.alt = value.mediaAlt === undefined ? value.alt : value.mediaAlt;
        record.media_type = "image";
        record.preview_image = preview;
        const result = tracked(record, "image", `${path}.images[${index}]`, {
          id: "mediaId",
          alt: value.mediaAlt === undefined ? "alt" : "mediaAlt",
        });
        objectKinds.set(result, "media_image");
        return result;
      });
    const variants = source.variants.map((variant, index) => {
      const options = source.options.map(
        (option) => variant.optionValues.find((value) => value.name === option.name)?.value ?? "",
      );
      const selected = variant.id === route.variant;
      return tracked(
        {
          id: id(variant.id),
          title: options.join(" / "),
          name:
            source.options.length === 1 &&
            source.options[0]?.name === "Title" &&
            source.options[0]?.values[0] === "Default Title"
              ? source.title
              : `${source.title} - ${options.join(" / ")}`,
          public_title:
            source.options.length === 1 &&
            source.options[0]?.name === "Title" &&
            source.options[0]?.values[0] === "Default Title"
              ? null
              : options.join(" / "),
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
          featured_media: media.find((i) => i.file === variant.image) ?? null,
          ...availableFields({
            quantity_rule: trackedJson(
              variant.quantityRule,
              "quantity_rule",
              `${path}.variants[${index}].quantity_rule`,
            ),
            quantity_price_breaks: trackedJson(
              variant.quantityPriceBreaks?.map((entry) => ({
                minimum_quantity: entry.minimumQuantity,
                price: liquidPrice(entry.price),
              })),
              "quantity_price_break",
              `${path}.variants[${index}].quantity_price_breaks`,
            ),
            unit_price:
              variant.unitPrice === undefined
                ? undefined
                : variant.unitPrice === null
                  ? null
                  : liquidPrice(variant.unitPrice),
            unit_price_measurement: trackedJson(
              variant.unitPriceMeasurement,
              "unit_price_measurement",
              `${path}.variants[${index}].unit_price_measurement`,
            ),
            requires_shipping: variant.requiresShipping,
            taxable: variant.taxable,
            weight: variant.weight,
            requires_selling_plan: variant.requiresSellingPlan,
            selling_plan_allocations: trackedJson(
              variant.sellingPlanAllocations,
              "selling_plan_allocation",
              `${path}.variants[${index}].selling_plan_allocations`,
            ),
            inventory_management: variant.inventoryManagement,
            inventory_policy: variant.inventoryPolicy,
            inventory_quantity: variant.inventoryQuantity,
            store_availabilities: trackedJson(
              variant.storeAvailabilities,
              "store_availability",
              `${path}.variants[${index}].store_availabilities`,
            ),
          }),
        },
        "variant",
        `${path}.variants[${index}]`,
      );
    });
    const selected = variants.find((variant) => variant.selected);
    for (const [index, record] of images.entries()) {
      const file = source.images[index]?.file;
      // Associations are getters so the graph is complete after variant construction and does not serialize cycles.
      Object.defineProperties(record, {
        product_id: {
          enumerable: true,
          get: () => {
            if (source.id === undefined) {
              hooks.unsupported("image", "product_id");
              return undefined;
            }
            return id(source.id);
          },
        },
        variants: {
          enumerable: false,
          get: () => variants.filter((_variant, index) => source.variants[index]?.image === file),
        },
        "attached_to_variant?": {
          enumerable: true,
          get: () => source.variants.some((variant) => variant.image === file),
        },
      });
    }
    const firstAvailable = variants.find((variant) => variant.available) ?? null;
    const prices = source.variants.map((variant) => liquidPrice(variant.price));
    const comparePrices = source.variants.flatMap((variant) =>
      variant.compareAtPrice === null ? [] : [liquidPrice(variant.compareAtPrice)],
    );
    const dto: LiquidRecord = {
      ...availableFields({
        created_at: source.createdAt,
        published_at: source.publishedAt,
        category: trackedJson(source.category, "taxonomy_category", `${path}.category`),
        id: source.id === undefined ? undefined : id(source.id),
        "gift_card?": source.giftCard,
        requires_selling_plan: source.requiresSellingPlan,
        selling_plan_groups: trackedJson(
          source.sellingPlanGroups,
          "selling_plan_group",
          `${path}.selling_plan_groups`,
        ),
        "quantity_price_breaks_configured?": source.quantityPriceBreaksConfigured,
      }),
      variants_count: variants.length,
      object_type: "product",
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
      media,
      featured_media: media[0] ?? null,
      metafields: source.metafields,
    };
    const product = tracked(dto, "product", path);
    products.set(source.handle, product);
    for (const variant of variants) Object.defineProperty(variant, "product", { value: product });
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
          ...availableFields({ id: source.id === undefined ? undefined : id(source.id) }),
          handle: source.handle,
          title: source.title,
          description: source.descriptionHtml,
          url: `/collections/${source.handle}`,
          products: members,
          products_count: members.length,
          all_products_count: members.length,
          image: source.image
            ? tracked(image(source.image), "image", `collections[${collectionIndex}].image`)
            : null,
          template_suffix: source.templateSuffix,
          default_sort_by: source.sortOrder,
          get sort_options() {
            return collectionSortOptions(source.sortOptions);
          },
          results_count: null,
          terms: null,
          current_vendor: null,
          current_type: null,
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
  if (!collections.has("all")) {
    const collator = new Intl.Collator(snapshot.shop.locale, { sensitivity: "base" });
    const members = [...products.values()].sort((a, b) =>
      collator.compare(String(a.title), String(b.title)),
    );
    collections.set(
      "all",
      tracked(
        {
          id: null,
          handle: "all",
          get title() {
            if (snapshot.shop.locale.split("-")[0] !== "en")
              hooks.unsupportedOperation?.(
                "Localized automatic collection titles are unavailable; English is used.",
              );
            return "Products";
          },
          description: "",
          products: members,
          products_count: members.length,
          all_products_count: members.length,
          url: "/collections/all",
          image: null,
          template_suffix: null,
          default_sort_by: "title-ascending",
          get sort_options() {
            return collectionSortOptions();
          },
          results_count: null,
          terms: null,
          current_vendor: null,
          current_type: null,
          sort_by: route.sortBy,
          filters: snapshot.filters,
        },
        "collection",
        "collections.all",
      ),
    );
  }
  const collectionDictionary = Object.fromEntries(collections);
  // The automatic catalog supports lookup, but is not a persisted collection in iteration.
  const listedCollections = snapshot.collections.flatMap((source) => {
    const value = collections.get(source.handle);
    return value ? [value] : [];
  });
  Object.defineProperty(collectionDictionary, Symbol.iterator, {
    value: () => listedCollections[Symbol.iterator](),
  });
  for (const [key, value] of Object.entries({
    size: listedCollections.length,
    first: listedCollections[0] ?? null,
    last: listedCollections.at(-1) ?? null,
  }))
    if (!Object.hasOwn(collectionDictionary, key))
      Object.defineProperty(collectionDictionary, key, { value, enumerable: false });
  const pages = new Map(
    snapshot.pages.map((source, index) => [
      source.handle,
      tracked(
        {
          ...availableFields({ id: source.id === undefined ? undefined : id(source.id) }),
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
          ...availableFields({ id: source.id === undefined ? undefined : id(source.id) }),
          handle: source.handle,
          title: source.title,
          url: `/blogs/${source.handle}`,
          template_suffix: source.templateSuffix,
          articles: source.articles.map((article, index) => {
            const dto = tracked(
              {
                ...availableFields({
                  comments_count: article.commentsCount,
                  created_at: article.createdAt,
                  updated_at: article.updatedAt,
                }),
                ...availableFields({ id: article.id === undefined ? undefined : id(article.id) }),
                handle: article.handle,
                title: article.title,
                content: article.bodyHtml,
                excerpt: article.excerptHtml,
                author: article.author,
                published_at: article.publishedAt,
                image: article.image
                  ? tracked(
                      image(article.image),
                      "image",
                      `blogs[${blogIndex}].articles[${index}].image`,
                    )
                  : null,
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
          ...availableFields({ "comments_enabled?": source.commentsEnabled }),
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
  function amount(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Cart amount exceeds safe Liquid numeric precision");
    return Number(value);
  }
  const items = snapshot.cart.lines.map((line, index) => {
    const source = snapshot.products.find((product) => product.handle === line.productHandle);
    const variantIndex =
      source?.variants.findIndex((variant) => variant.id === line.variantId) ?? -1;
    const variantSource = source?.variants[variantIndex];
    const product = products.get(line.productHandle);
    if (!source || !variantSource || !product)
      throw new Error("Cart variant is absent from snapshot");
    const variants = product.variants;
    const variant = Array.isArray(variants) ? variants[variantIndex] : undefined;
    if (!variant || typeof variant !== "object")
      throw new Error("Cart variant derivation is unavailable");
    const price = liquidPrice(variantSource.price);
    const linePrice = amount(BigInt(price) * BigInt(line.quantity));
    const variantTitle = source.options
      .map(
        (option) =>
          variantSource.optionValues.find((value) => value.name === option.name)?.value ?? "",
      )
      .join(" / ");
    const lineImage = source.images.find((image) => image.file === variantSource.image);
    return tracked(
      {
        id: id(line.variantId),
        index,
        variant_id: id(line.variantId),
        product,
        variant,
        quantity: line.quantity,
        title: product.has_only_default_variant
          ? source.title
          : `${source.title} - ${variantTitle}`,
        product_title: source.title,
        variant_title: variantTitle,
        vendor: source.vendor,
        sku: variantSource.sku,
        image: lineImage
          ? image(lineImage, source.images.indexOf(lineImage))
          : product.featured_image,
        url: `/products/${source.handle}?variant=${encodeURIComponent(line.variantId)}`,
        options_with_values: variantSource.optionValues,
        original_price: price,
        final_price: price,
        price,
        original_line_price: linePrice,
        final_line_price: linePrice,
        line_price: linePrice,
        line_level_discount_allocations: [],
        line_level_total_discount: 0,
        discount_allocations: [],
        discounts: [],
        total_discount: 0,
        properties: {},
        selling_plan_allocation: null,
        ...availableFields({
          key: line.key,
          instructions: trackedJson(
            line.instructions,
            "instructions",
            `cart.lines[${index}].instructions`,
          ),
          parent_relationship: trackedJson(
            line.parentRelationship,
            "parent_relationship",
            `cart.lines[${index}].parent_relationship`,
          ),
          item_components: trackedJson(
            line.itemComponents,
            "line_item",
            `cart.lines[${index}].item_components`,
          ),
          url_to_remove:
            line.key === undefined
              ? undefined
              : `/cart/change?id=${encodeURIComponent(line.key).replace(/%3A/gi, ":")}&quantity=0`,
        }),
        ...availableFields({
          unit_price: variant.unit_price,
          unit_price_measurement: variant.unit_price_measurement,
        }),
      },
      "line_item",
      `cart.lines[${index}]`,
    );
  });
  const cartTotal = amount(
    items.reduce((sum, item) => sum + BigInt(Number(item.final_line_price)), 0n),
  );
  const count = amount(snapshot.cart.lines.reduce((sum, line) => sum + BigInt(line.quantity), 0n));
  const cart = tracked(
    {
      items,
      item_count: count,
      "empty?": items.length === 0,
      note: snapshot.cart.note,
      original_total_price: cartTotal,
      items_subtotal_price: cartTotal,
      total_price: cartTotal,
      total_discount: 0,
      cart_level_discount_applications: [],
      discount_applications: [],
      attributes: {},
      currency: { iso_code: snapshot.shop.currency },
      ...availableFields({
        taxes_included: snapshot.cart.taxesIncluded,
        duties_included: snapshot.cart.dutiesIncluded,
      }),
    },
    "cart",
    "cart",
  );
  const candidates: SearchCandidate<LiquidRecord>[] = [];
  for (const source of snapshot.products) {
    const value = products.get(source.handle);
    if (value)
      candidates.push({
        type: "product",
        value,
        text: [
          source.title,
          source.descriptionHtml,
          source.vendor,
          source.productType,
          ...source.tags,
          ...source.variants.map((v) => v.sku),
        ].join(" "),
        available: source.variants.some((v) => v.available),
        price: Math.min(...source.variants.map((v) => liquidPrice(v.price))),
      });
  }
  for (const source of snapshot.pages) {
    const value = pages.get(source.handle);
    if (value)
      candidates.push({
        type: "page",
        value,
        text: `${source.title} ${source.bodyHtml}`,
        available: true,
        price: null,
      });
  }
  for (const blog of snapshot.blogs)
    for (const source of blog.articles) {
      const value = articles.get(blog.handle)?.get(source.handle);
      if (value)
        candidates.push({
          type: "article",
          value,
          text: [
            source.title,
            source.bodyHtml,
            source.excerptHtml,
            source.author,
            ...source.tags,
          ].join(" "),
          available: true,
          price: null,
        });
    }
  let results: LiquidRecord[] | undefined;
  function matching(): LiquidRecord[] {
    if (results) return results;
    results = searchResults(candidates, route.path, (message) =>
      hooks.unsupportedOperation
        ? hooks.unsupportedOperation(message)
        : hooks.unsupported("search", message),
    ).map((candidate) => {
      const result = new Proxy(candidate.value, {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target);
          return keys.includes("object_type") ? keys : [...keys, "object_type"];
        },
        getOwnPropertyDescriptor(target, key) {
          return key === "object_type"
            ? { configurable: true, enumerable: true, writable: false, value: candidate.type }
            : Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          return key === "object_type" ? candidate.type : Reflect.get(target, key, receiver);
        },
      });
      objectKinds.set(result, candidate.type);
      return result;
    });
    return results;
  }
  const search = tracked(
    {
      id: null,
      url: null,
      terms: route.q,
      performed: new URL(route.path, "https://offline.invalid").searchParams.has("q"),
      get results() {
        return matching();
      },
      get results_count() {
        return matching().length;
      },
      default_sort_by: "relevance",
      sort_by: route.sortBy ?? "relevance",
      sort_options: [
        { name: "Relevance", value: "relevance" },
        { name: "Price, low to high", value: "price-ascending" },
        { name: "Price, high to low", value: "price-descending" },
      ],
      filters: snapshot.filters,
    },
    "search",
    "search",
  );
  const globals: LiquidRecord = {
    images: new ImageDirectory(snapshot.images, hooks.read, (property) =>
      hooks.unsupported("image", property),
    ),
    shop: tracked(
      {
        ...Object.fromEntries(
          Object.entries(snapshot.shop).filter(
            ([key]) => !["seo", "permanentDomain"].includes(key),
          ),
        ),
        ...availableFields({
          id: snapshot.shop.id === undefined ? undefined : id(snapshot.shop.id),
          permanent_domain: snapshot.shop.permanentDomain,
        }),
        products_count: snapshot.products.length,
        collections_count: snapshot.collections.length,
        ...(snapshot.shop.features
          ? { features: tracked(snapshot.shop.features, "shop.features", "shop.features") }
          : {}),
        ...(snapshot.shop.policies
          ? {
              policies: snapshot.shop.policies.map((source, index) => {
                class Policy extends Drop {
                  #field(key: "id" | "title" | "body" | "url") {
                    hooks.read(`shop.policies[${index}].${key}`);
                    if (!Object.hasOwn(source, key)) hooks.unsupported("policy", key);
                    return key === "id" && source.id ? id(source.id) : source[key];
                  }
                  get id() {
                    return this.#field("id");
                  }
                  get title() {
                    return this.#field("title");
                  }
                  get body() {
                    return this.#field("body");
                  }
                  get url() {
                    return this.#field("url");
                  }
                  valueOf() {
                    return this.body;
                  }
                  liquidMethodMissing(key: string) {
                    if (!internal.has(key)) hooks.unsupported("policy", key);
                    return undefined;
                  }
                }
                return new Policy();
              }),
            }
          : {}),
      },
      "shop",
      "shop",
      { permanent_domain: "permanentDomain" },
    ),
    cart,
    search,
    all_products: tracked(Object.fromEntries(products), "dictionary", "all_products"),
    collections: tracked(collectionDictionary, "dictionary", "collections"),
    pages: tracked(Object.fromEntries(pages), "dictionary", "pages"),
    blogs: tracked(Object.fromEntries(blogs), "dictionary", "blogs"),
    linklists: tracked(menuMap, "dictionary", "linklists"),
    request: tracked(
      {
        path:
          route.pageType === "404" ? null : new URL(route.path, "https://offline.invalid").pathname,
        page_type: route.pageType,
        design_mode: route.designMode,
        visual_preview_mode: false,
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
  if (snapshot.shop.policies !== undefined) {
    const shop = globals.shop;
    if (
      shop !== null &&
      typeof shop === "object" &&
      "policies" in shop &&
      Array.isArray(shop.policies)
    ) {
      const policies = shop.policies;
      for (const key of [
        "shipping_policy",
        "privacy_policy",
        "refund_policy",
        "terms_of_service",
        "subscription_policy",
      ])
        Object.defineProperty(shop, key, {
          enumerable: true,
          get() {
            return (
              policies.find((policy) => policy.url === `/policies/${key.replaceAll("_", "-")}`) ??
              null
            );
          },
        });
    }
  }
  if (route.pageType === "product")
    globals.product = products.get(route.resourceHandle ?? "") ?? null;
  if (route.pageType === "collection")
    globals.collection = collections.get(route.resourceHandle ?? "") ?? null;
  if (route.pageType === "page") globals.page = pages.get(route.resourceHandle ?? "") ?? null;
  if (route.pageType === "blog") globals.blog = blogs.get(route.resourceHandle ?? "") ?? null;
  if (route.pageType === "article") {
    const blog = blogs.get(route.blogHandle ?? "");
    globals.blog = blog ?? null;
    globals.article = articles.get(route.blogHandle ?? "")?.get(route.resourceHandle ?? "") ?? null;
  }
  globals.closest = tracked(
    {
      product: globals.product ?? null,
      collection: globals.collection ?? null,
      page: globals.page ?? null,
      blog: globals.blog ?? null,
      article: globals.article ?? null,
    },
    "closest",
    "closest",
  );
  return globals;
}
