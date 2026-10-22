import { Drop } from "liquidjs";
import { LiquidFloat } from "./float.js";
import { handleize } from "./handle.js";
import { ImageDirectory, localImageUrl } from "./images.js";
import { focalPoint, ScalarDrop } from "./scalar-drop.js";
import type { PartialMenuLink as MenuLink, ProductMedia, Snapshot } from "./schema.js";
import { type SearchCandidate, searchResults } from "./search.js";
import { shopTime } from "./shop-time.js";
import { storefrontQuery } from "./storefront-filters.js";

export { ScalarDrop };
export type LiquidRecord = Record<string, unknown>;
/** One known available variant establishes availability even when siblings are unknown. */
function productAvailability(
  variants: Snapshot["products"][number]["variants"],
): boolean | undefined {
  if (variants.some((variant) => variant.available === true)) return true;
  return variants.some((variant) => variant.available === undefined) ? undefined : false;
}

const objectKinds = new WeakMap<object, string>();
const mediaTitles = new WeakMap<object, string>();
/** The title of the product that owns video, external video or model media. */
export function mediaProductTitle(media: object): string | undefined {
  return mediaTitles.get(media);
}
/**
 * The distinct non-empty values of a product field across a collection's products, in
 * alphabetical order, as Shopify returns `all_tags` (and, as measured, `all_types`/`all_vendors`).
 */
function memberValues(members: readonly LiquidRecord[], key: "tags" | "type" | "vendor"): string[] {
  const values = members.flatMap((product) => {
    const value: unknown = product[key];
    return Array.isArray(value) ? value : [value];
  });
  const distinct = [
    ...new Set(values.filter((v): v is string => typeof v === "string" && v !== "")),
  ].sort();
  // Shopify documents that all_tags returns at most 1,000 tags.
  return key === "tags" ? distinct.slice(0, 1000) : distinct;
}
export function liquidObjectKind(value: unknown): string | undefined {
  return value !== null && typeof value === "object" ? objectKinds.get(value) : undefined;
}
export function preserveLiquidObjectKind(source: unknown, target: object): void {
  const kind = liquidObjectKind(source);
  if (kind !== undefined) objectKinds.set(target, kind);
}
/**
 * Standard storefront paths for the primary locale. Customer-account profile and storefront
 * login URLs depend on the shop's account host, so they stay absent and are diagnosed on access.
 */
const routePaths = {
  root_url: "/",
  account_url: "/account",
  account_login_url: "/account/login",
  account_logout_url: "/account/logout",
  account_recover_url: "/account/recover",
  account_register_url: "/account/register",
  account_addresses_url: "/account/addresses",
  collections_url: "/collections",
  all_products_collection_url: "/collections/all",
  search_url: "/search",
  predictive_search_url: "/search/suggest",
  cart_url: "/cart",
  cart_add_url: "/cart/add",
  cart_change_url: "/cart/change",
  cart_clear_url: "/cart/clear",
  cart_update_url: "/cart/update",
  product_recommendations_url: "/recommendations/products",
} as const;
export interface ObjectHooks {
  read(path: string): void;
  unsupported(type: string, property: string): void;
  unsupportedOperation?(message: string): void;
  /** Data the snapshot does not supply, or a reference to an absent resource; it resolves to nil. */
  missing?(message: string): void;
  /** Converts a source color string into the renderer's Liquid color object. */
  color?(value: string): unknown;
  /** Output only Shopify's servers can produce; it is omitted offline. */
  serverOnly?(message: string): void;
}
/** Records the reads of a Liquid object and diagnoses properties it does not have. */
export type ObjectTracker = <T extends object>(
  value: T,
  type: string,
  path?: string | null,
  sourceKeys?: Readonly<Record<string, string | null>>,
) => T;
// Properties LiquidJS probes on its own (generator results, thenables, the Comparable protocol).
const internalKeys = new Set([
  "next",
  "then",
  "toLiquid",
  "toJSON",
  "constructor",
  "__proto__",
  "prototype",
  "equals",
  "gt",
  "geq",
  "lt",
  "leq",
]);
// Lookups by merchant-defined keys: an absent key is ordinary nil, not a missing feature.
const openTypes = new Set(["settings", "dictionary", "metafields", "metaobject"]);
const absentMarker = "sop:absent";
/**
 * Defined values only. The names of omitted source fields travel with the record (object spread
 * copies the enumerable symbol), so reading one reports missing data rather than a missing feature.
 */
export function availableFields(values: LiquidRecord): LiquidRecord {
  const result: LiquidRecord = {};
  const absent: string[] = [];
  for (const [key, value] of Object.entries(values))
    if (value === undefined) absent.push(key);
    else result[key] = value;
  if (absent.length)
    Object.defineProperty(result, Symbol(absentMarker), { value: absent, enumerable: true });
  return result;
}
function absentFields(target: object): string[] {
  return Object.getOwnPropertySymbols(target).flatMap((symbol) => {
    const keys: unknown = symbol.description === absentMarker ? Reflect.get(target, symbol) : [];
    return Array.isArray(keys) ? keys.map(String) : [];
  });
}
/** Native filters explicitly consume fields just as Liquid property access does. */
export function readSnapshotProperty(value: Record<string, unknown>, key: string): unknown {
  if (absentFields(value).includes(key)) Reflect.getOwnPropertyDescriptor(value, key);
  return value[key];
}
let typeRecorder: ((type: string, keys: readonly string[]) => void) | undefined;
/** Runs `run` while reporting the type and own properties of every newly tracked object. */
export async function recordObjectTypes<T>(
  record: (type: string, keys: readonly string[]) => void,
  run: () => Promise<T>,
): Promise<T> {
  const previous = typeRecorder;
  typeRecorder = record;
  try {
    return await run();
  } finally {
    typeRecorder = previous;
  }
}
/**
 * Proxies record snapshot reads (a null path records none) and report every other property: an
 * omitted source field as missing data, anything else as not available offline.
 */
export function objectTracker(hooks: ObjectHooks): ObjectTracker {
  const cache = new WeakMap<object, Map<string, object>>();
  return function tracked<T extends object>(
    value: T,
    type: string,
    path: string | null = null,
    sourceKeys?: Readonly<Record<string, string | null>>,
  ): T {
    let entries = cache.get(value);
    if (!entries) {
      entries = new Map();
      cache.set(value, entries);
    }
    const cached = entries.get(`${type}:${path ?? ""}`);
    // Cache keys identify the same object and wrapper type; Proxy<T> preserves T's shape.
    if (cached) return cached as T;
    typeRecorder?.(
      type,
      Reflect.ownKeys(value).filter((key): key is string => typeof key === "string"),
    );
    const result = new Proxy(value, {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        if (
          !descriptor &&
          typeof key === "string" &&
          !internalKeys.has(key) &&
          !Array.isArray(target) &&
          !openTypes.has(type)
        ) {
          if (hooks.missing && absentFields(target).includes(key))
            hooks.missing(`Object property ${type}.${key} is absent from the snapshot.`);
          else hooks.unsupported(type, key);
        }
        return descriptor;
      },
      get(target, key, receiver) {
        if (typeof key !== "string") return Reflect.get(target, key, receiver);
        // `paginate.next` is Liquid data; only engine probes for methods are hidden.
        if (
          internalKeys.has(key) &&
          (!Object.hasOwn(target, key) || typeof Reflect.get(target, key) === "function")
        )
          return undefined;
        if (Object.hasOwn(target, key)) {
          const source = sourceKeys && Object.hasOwn(sourceKeys, key) ? sourceKeys[key] : key;
          if (source !== null && path !== null)
            hooks.read(Array.isArray(target) ? `${path}[${source}]` : `${path}.${source}`);
          return Reflect.get(target, key, receiver);
        }
        if (Array.isArray(target) || openTypes.has(type)) return Reflect.get(target, key, receiver);
        // Drops keep their scalar conversion and missing-property protocol behind the proxy.
        if (target instanceof Drop && (key === "valueOf" || key === "liquidMethodMissing")) {
          const method: unknown = Reflect.get(target, key);
          return typeof method === "function" ? method.bind(target) : method;
        }
        // LiquidJS probes iterator/thenable properties directly; missing Liquid
        // properties are diagnosed by its own-property descriptor lookup above.
        return undefined;
      },
    });
    entries.set(`${type}:${path ?? ""}`, result);
    objectKinds.set(result, type);
    return result;
  };
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

// Primary languages written right to left (CLDR character order), as `shop_locale.direction`.
const rightToLeft = new Set([
  "ar",
  "arc",
  "ckb",
  "dv",
  "fa",
  "he",
  "iw",
  "ks",
  "ps",
  "sd",
  "ug",
  "ur",
  "yi",
]);
function direction(isoCode: string): "rtl" | "ltr" {
  return rightToLeft.has(isoCode.split("-")[0]?.toLowerCase() ?? "") ? "rtl" : "ltr";
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
function sourceId(value: string | null | undefined): number | string | null | undefined {
  return value === undefined || value === null ? value : id(value);
}

type SourceImage = Snapshot["products"][number]["images"][number];
// Shopify reports the image center when no focal point is set.
const unsetFocalPoint = { x: "0.5", y: "0.5" };
/** Image fields shared by product, collection, article, media preview and shop images. */
function imageFields(
  value: SourceImage,
  path: string,
  tracked: ObjectTracker,
  index: number | null = null,
): LiquidRecord {
  const src = `/sop/images/${value.file.split("/").map(encodeURIComponent).join("/")}`;
  return {
    file: value.file,
    alt: value.alt,
    ...availableFields({
      width: value.width,
      height: value.height,
      aspect_ratio:
        value.width === undefined || value.height === undefined
          ? undefined
          : value.width / value.height,
    }),
    src,
    url: src,
    position: index === null ? null : index + 1,
    product_id: null,
    variants: null,
    "attached_to_variant?": null,
    media_type: null,
    preview_image: null,
    ...availableFields({
      presentation:
        value.focalPoint === undefined
          ? undefined
          : tracked(
              {
                focal_point: tracked(
                  focalPoint(value.focalPoint ?? unsetFocalPoint),
                  "focal_point",
                  `${path}.focalPoint`,
                  { x: null, y: null },
                ),
              },
              "image_presentation",
              path,
              { focal_point: "focalPoint" },
            ),
    }),
  };
}
/** A standalone snapshot image, such as the shop's social sharing image. */
export function imageObject(value: SourceImage, path: string, tracked: ObjectTracker): object {
  return tracked(
    { ...imageFields(value, path, tracked), ...availableFields({ id: sourceId(value.id) }) },
    "image",
    path,
  );
}
const policyAliases = [
  "shipping_policy",
  "privacy_policy",
  "refund_policy",
  "terms_of_service",
  "subscription_policy",
];
/** Documented globals that exist on Shopify but have no offline value; reading one is diagnosed. */
export const unavailableGlobals: readonly string[] = [
  "all_country_option_tags",
  "country_option_tags",
  "content_for_index",
  "scripts",
  "theme",
];
/** Source-backed fields plus explicit derivation; omitted fields are observed, never invented. */
export function liquidObjects(
  snapshot: Snapshot,
  route: RouteContext,
  hooks: ObjectHooks,
  tracked: ObjectTracker = objectTracker(hooks),
): LiquidRecord {
  // Timestamps print in the shop's timezone; an absent one stays absent.
  const time = (iso: string | null | undefined) =>
    iso === undefined ? undefined : shopTime(iso, snapshot.shop.timezone);
  function absent(type: string, property: string) {
    if (hooks.missing)
      hooks.missing(`Object property ${type}.${property} is absent from the snapshot.`);
    else hooks.unsupported(type, property);
  }
  const image = (value: SourceImage, path: string, index: number | null = null) =>
    imageFields(value, path, tracked, index);
  /** Video, external video and 3D model media; their preview images have no ID. */
  function otherMedia(
    entry: Exclude<ProductMedia, { mediaType: "image" }>,
    path: string,
    index: number,
    title: string,
  ): object {
    const result = mediaObject(entry, path, index);
    mediaTitles.set(result, title);
    return result;
  }
  function mediaObject(
    entry: Exclude<ProductMedia, { mediaType: "image" }>,
    path: string,
    index: number,
  ): object {
    const preview =
      entry.previewImage === undefined
        ? undefined
        : tracked(
            { ...image(entry.previewImage, `${path}.previewImage`), id: null },
            "image",
            `${path}.previewImage`,
            { id: null },
          );
    const common = {
      ...availableFields({ id: sourceId(entry.id) }),
      alt: entry.alt,
      media_type: entry.mediaType,
      position: index + 1,
      ...availableFields({ preview_image: preview }),
    };
    const keys = { media_type: "mediaType", position: null, preview_image: "previewImage" };
    if (entry.mediaType === "external_video")
      return tracked(
        {
          ...common,
          host: entry.host,
          external_id: entry.externalId,
          ...availableFields({
            aspect_ratio:
              entry.previewImage?.width === undefined || entry.previewImage.height === undefined
                ? undefined
                : entry.previewImage.width / entry.previewImage.height,
          }),
        },
        "external_video",
        path,
        { ...keys, external_id: "externalId", aspect_ratio: "previewImage" },
      );
    const sources = tracked(
      entry.sources.map((source, sourceIndex) =>
        tracked(
          {
            url: localImageUrl(source.file),
            format: source.format,
            mime_type: source.mimeType,
            ...("width" in source ? { width: source.width, height: source.height } : {}),
          },
          entry.mediaType === "video" ? "video_source" : "model_source",
          `${path}.sources[${sourceIndex}]`,
          { url: "file", mime_type: "mimeType" },
        ),
      ),
      entry.mediaType === "video" ? "video_source" : "model_source",
      `${path}.sources`,
    );
    if (entry.mediaType === "model") return tracked({ ...common, sources }, "model", path, keys);
    const first = entry.sources[0];
    return tracked(
      {
        ...common,
        sources,
        aspect_ratio: first ? first.width / first.height : null,
        ...availableFields({ duration: entry.duration }),
      },
      "video",
      path,
      { ...keys, aspect_ratio: "sources" },
    );
  }
  function trackedJson(value: unknown, type: string, path: string): unknown {
    if (value instanceof Number) return value;
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
  /**
   * A snapshot metafield written as `{ "type": <Shopify type>, "value": <Liquid value> }` has
   * Shopify's metafield properties and outputs its value. Any other JSON is a legacy metafield
   * value and is exposed unchanged.
   */
  function typedMetafield(value: unknown): value is { type: string; value: unknown } {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      "value" in value &&
      "type" in value &&
      typeof value.type === "string"
    );
  }
  function metafield(type: string | undefined, value: unknown, path: string): object {
    const reference = type !== undefined && /_reference$/.test(type);
    return tracked(
      new ScalarDrop(
        {
          ...availableFields({ type, "list?": type?.startsWith("list.") }),
          get value() {
            if (!reference) return value;
            hooks.unsupportedOperation?.(
              `Metafield reference ${path} is not resolved to a resource offline.`,
            );
            return null;
          },
        },
        value === null || ["string", "number", "boolean"].includes(typeof value)
          ? value
          : JSON.stringify(value),
      ),
      "metafield",
      path,
      { "list?": "type" },
    );
  }
  function metafields(source: Snapshot["products"][number]["metafields"], path: string) {
    return Object.fromEntries(
      Object.entries(source).map(([namespace, fields]) => [
        namespace,
        Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key,
            typedMetafield(value)
              ? metafield(value.type, value.value, `${path}.${namespace}.${key}`)
              : value,
          ]),
        ),
      ]),
    );
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
  function collectionSortOptions(
    supplied: Snapshot["collections"][number]["sortOptions"],
    path: string,
  ) {
    if (supplied)
      return tracked(
        supplied.map((option, index) =>
          tracked({ ...option }, "sort_option", `${path}.sortOptions[${index}]`),
        ),
        "sort_option",
        `${path}.sortOptions`,
      );
    if (snapshot.shop.locale === undefined) {
      absent("shop", "locale (sort_options)");
      return undefined;
    }
    if (snapshot.shop.locale.split("-")[0] !== "en")
      hooks.missing?.(
        "Localized collection sort labels are absent from the snapshot; English is used.",
      );
    return sortOptions.map((option) => tracked({ ...option }, "sort_option"));
  }
  for (const [productIndex, source] of snapshot.products.entries()) {
    const path = `products[${productIndex}]`;
    const images = source.images.map((value, index) =>
        tracked(
          {
            ...image(value, `${path}.images[${index}]`, index),
            ...availableFields({ id: sourceId(value.id) }),
          },
          "image",
          `${path}.images[${index}]`,
        ),
      ),
      // With explicit media, an image's media position is its place among all media.
      mediaPosition = (index: number) => {
        const file = source.images[index]?.file;
        const position = source.media?.findIndex(
          (entry) => entry.mediaType === "image" && entry.file === file,
        );
        return position === undefined || position < 0 ? index : position;
      },
      mediaImages = source.images.map((value, index) => {
        const imagePath = `${path}.images[${index}]`;
        const preview = tracked(
          {
            ...image(value, imagePath),
            id: null,
            alt:
              value.previewAlt === undefined
                ? value.mediaAlt === undefined
                  ? value.alt
                  : value.mediaAlt
                : value.previewAlt,
          },
          "image",
          imagePath,
          {
            id: null,
            alt:
              value.previewAlt !== undefined
                ? "previewAlt"
                : value.mediaAlt !== undefined
                  ? "mediaAlt"
                  : "alt",
          },
        );
        // A media ID is never inferred from the classic image ID.
        const record: LiquidRecord = {
          ...image(value, imagePath, mediaPosition(index)),
          ...availableFields({ id: sourceId(value.mediaId) }),
          alt: value.mediaAlt === undefined ? value.alt : value.mediaAlt,
          media_type: "image",
          preview_image: preview,
        };
        const result = tracked(record, "image", imagePath, {
          id: "mediaId",
          alt: value.mediaAlt === undefined ? "alt" : "mediaAlt",
        });
        objectKinds.set(result, "media_image");
        return result;
      }),
      media = source.media
        ? source.media.map((entry, index) =>
            entry.mediaType === "image"
              ? mediaImages[source.images.findIndex((value) => value.file === entry.file)]
              : otherMedia(entry, `${path}.media[${index}]`, index, source.title),
          )
        : mediaImages;
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
          ...availableFields({ available: variant.available }),
          sku: variant.sku,
          barcode: variant.barcode,
          selected,
          url: `/products/${source.handle}?variant=${encodeURIComponent(variant.id)}`,
          ...availableFields({
            image:
              variant.image === undefined
                ? undefined
                : (images.find((i) => i.file === variant.image) ?? null),
            featured_image:
              variant.image === undefined
                ? undefined
                : (images.find((i) => i.file === variant.image) ?? null),
            featured_media:
              variant.image === undefined
                ? undefined
                : (mediaImages.find((i) => i.file === variant.image) ?? null),
          }),
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
              variant.unitPriceMeasurement && {
                ...variant.unitPriceMeasurement,
                // Shopify keeps the quantity as a Float, so 250 prints as 250.0 (measured on a
                // store in Germany); the reference value is an Integer.
                quantity_value: new LiquidFloat(variant.unitPriceMeasurement.quantity_value),
              },
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
              absent("image", "product_id");
              return undefined;
            }
            return id(source.id);
          },
        },
        variants: {
          enumerable: false,
          get: () => {
            if (source.variants.some((variant) => variant.image === undefined)) {
              absent("image", "variants");
              return undefined;
            }
            return variants.filter((_variant, index) => source.variants[index]?.image === file);
          },
        },
        "attached_to_variant?": {
          enumerable: true,
          get: () => {
            if (source.variants.some((variant) => variant.image === undefined)) {
              absent("image", "attached_to_variant?");
              return undefined;
            }
            return source.variants.some((variant) => variant.image === file);
          },
        },
      });
    }
    const availabilityKnown = source.variants.every((variant) => variant.available !== undefined);
    const firstAvailable = availabilityKnown
      ? (variants.find((_variant, index) => source.variants[index]?.available) ?? null)
      : undefined;
    const current = selected ?? firstAvailable ?? variants[0];
    const optionRows = source.variants.map((variant) =>
      source.options.map(
        (option) => variant.optionValues.find((value) => value.name === option.name)?.value ?? "",
      ),
    );
    const currentRow = optionRows[current ? variants.indexOf(current) : -1] ?? [];
    // Shopify derives option value state from the selected-or-first-available variant: earlier
    // options constrain availability, and `variant` swaps only this option's value.
    const optionsWithValues = source.options.map((option, index) =>
      tracked(
        {
          name: option.name,
          position: index + 1,
          values: tracked(
            option.values.map((value, valueIndex) => {
              const isSelected = currentRow[index] === value;
              const swapped = currentRow.map((entry, position) =>
                position === index ? value : entry,
              );
              const match = isSelected
                ? current
                : variants[optionRows.findIndex((row) => row.every((v, i) => v === swapped[i]))];
              const swatch = option.swatches?.[valueIndex];
              const swatchPath = `${path}.options[${index}].swatches[${valueIndex}]`;
              const fields: LiquidRecord = {
                name: value,
                ...availableFields({
                  available: availabilityKnown
                    ? source.variants.some(
                        (variant, row) =>
                          variant.available &&
                          optionRows[row]?.[index] === value &&
                          currentRow.slice(0, index).every((v, i) => optionRows[row]?.[i] === v),
                      )
                    : undefined,
                  selected: availabilityKnown || selected ? isSelected : undefined,
                  variant: availabilityKnown || selected ? (match ?? null) : undefined,
                }),
                // Snapshots have no combined listings, so no value points at another product.
                product_url: null,
                ...availableFields({
                  id: sourceId(option.valueIds?.[valueIndex]),
                  swatch:
                    swatch === undefined || swatch === null
                      ? swatch
                      : tracked(
                          {
                            color:
                              swatch.color === null
                                ? null
                                : (hooks.color?.(swatch.color) ?? swatch.color),
                            image: swatch.image
                              ? tracked(
                                  {
                                    ...image(swatch.image, `${swatchPath}.image`),
                                    ...availableFields({ id: sourceId(swatch.image.id) }),
                                  },
                                  "image",
                                  `${swatchPath}.image`,
                                )
                              : null,
                          },
                          "swatch",
                          swatchPath,
                        ),
                }),
              };
              // Themes measure option labels with `value.size`, the name's length.
              Object.defineProperty(fields, "size", { value: value.length, enumerable: false });
              return tracked(
                new ScalarDrop(fields, value),
                "product_option_value",
                `${path}.options[${index}]`,
                {
                  name: `values[${valueIndex}]`,
                  selected: null,
                  available: null,
                  variant: null,
                  product_url: null,
                  size: `values[${valueIndex}]`,
                  id: `valueIds[${valueIndex}]`,
                  swatch: `swatches[${valueIndex}]`,
                },
              );
            }),
            "product_option_value",
            `${path}.options[${index}].values`,
          ),
          ...availableFields({
            selected_value: availabilityKnown || selected ? (currentRow[index] ?? null) : undefined,
          }),
        },
        "product_option",
        `${path}.options[${index}]`,
        { position: null, selected_value: null },
      ),
    );
    const prices = source.variants.map((variant) => liquidPrice(variant.price));
    const comparePrices = source.variants.flatMap((variant) =>
      variant.compareAtPrice === null ? [] : [liquidPrice(variant.compareAtPrice)],
    );
    const dto: LiquidRecord = {
      ...availableFields({
        created_at: time(source.createdAt),
        published_at: time(source.publishedAt),
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
      // Shopify keeps a product's tags in alphabetical order (measured).
      tags: [...source.tags].sort(),
      template_suffix: source.templateSuffix,
      url: `/products/${source.handle}`,
      ...availableFields({
        available: productAvailability(source.variants),
      }),
      price: Math.min(...prices),
      price_min: Math.min(...prices),
      price_max: Math.max(...prices),
      price_varies: new Set(prices).size > 1,
      compare_at_price: comparePrices.length ? Math.min(...comparePrices) : null,
      compare_at_price_min: comparePrices.length ? Math.min(...comparePrices) : null,
      compare_at_price_max: comparePrices.length ? Math.max(...comparePrices) : null,
      compare_at_price_varies: new Set(comparePrices).size > 1,
      variants,
      ...availableFields({ first_available_variant: firstAvailable }),
      selected_variant: selected ?? null,
      ...availableFields({
        selected_or_first_available_variant:
          selected ?? (availabilityKnown ? (firstAvailable ?? variants[0] ?? null) : undefined),
      }),
      has_only_default_variant:
        source.options.length === 1 &&
        source.options[0]?.name === "Title" &&
        source.options[0].values.length === 1 &&
        source.options[0].values[0] === "Default Title",
      options: source.options.map((option) => option.name),
      options_with_values: optionsWithValues,
      images,
      featured_image: images[0] ?? null,
      media,
      featured_media: media[0] ?? null,
      metafields: metafields(source.metafields, `${path}.metafields`),
    };
    const product = tracked(dto, "product", path);
    products.set(source.handle, product);
    for (const variant of variants) Object.defineProperty(variant, "product", { value: product });
  }
  const productSources = new Map(snapshot.products.map((source) => [source.handle, source]));
  const viewed = (handle: string) =>
    route.pageType === "collection" && route.resourceHandle === handle;
  /** Filter objects and the filtered, sorted members, derived once on first use. */
  function collectionQuery(handle: string, handles: string[], defaultSortBy: string) {
    let result: ReturnType<typeof storefrontQuery> | undefined;
    return () => {
      const parameters = new URL(route.path, "https://offline.invalid").searchParams;
      if (
        viewed(handle) &&
        [...parameters.keys()].some((key) => key.startsWith("filter.")) &&
        (snapshot.filters === undefined ||
          (parameters.has("filter.v.availability") &&
            handles.some((member) =>
              productSources
                .get(member)
                ?.variants.some((variant) => variant.available === undefined),
            )))
      ) {
        absent("collection", "products (filters or variant.available)");
        return undefined;
      }
      result ??= storefrontQuery(
        snapshot,
        route.path,
        handles.flatMap((member) => {
          const source = productSources.get(member),
            value = products.get(member);
          return source && value ? [{ source, value }] : [];
        }),
        {
          apply: viewed(handle),
          sortBy: route.sortBy,
          defaultSortBy,
          track: tracked,
          unsupported: (message) => hooks.unsupportedOperation?.(message),
          missing: (message) =>
            hooks.missing ? hooks.missing(message) : hooks.unsupportedOperation?.(message),
        },
      );
      return result;
    };
  }
  for (const [collectionIndex, source] of snapshot.collections.entries()) {
    const members = source.products?.flatMap((handle) => {
      const product = products.get(handle);
      return product ? [product] : [];
    });
    const query = collectionQuery(source.handle, source.products ?? [], source.sortOrder);
    const collectionImage = source.image
      ? tracked(
          {
            ...image(source.image, `collections[${collectionIndex}].image`),
            ...availableFields({ id: sourceId(source.image.id) }),
          },
          "image",
          `collections[${collectionIndex}].image`,
        )
      : source.image;
    const unknown = (property: string) => {
      absent("collection", `${property} (collections[${collectionIndex}])`);
      return undefined;
    };
    collections.set(
      source.handle,
      tracked(
        {
          ...availableFields({ id: source.id === undefined ? undefined : id(source.id) }),
          handle: source.handle,
          title: source.title,
          description: source.descriptionHtml,
          url: `/collections/${source.handle}`,
          get products() {
            return members === undefined ? unknown("products") : query()?.products;
          },
          get products_count() {
            return members === undefined ? unknown("products_count") : query()?.products.length;
          },
          ...availableFields({ all_products_count: members?.length }),
          get all_tags() {
            return members === undefined ? unknown("all_tags") : memberValues(members, "tags");
          },
          get all_types() {
            return members === undefined ? unknown("all_types") : memberValues(members, "type");
          },
          get all_vendors() {
            return members === undefined ? unknown("all_vendors") : memberValues(members, "vendor");
          },
          ...availableFields({ image: collectionImage }),
          // The collection image, else the first product's featured image.
          get featured_image() {
            if (collectionImage === undefined) return unknown("image");
            if (collectionImage) return collectionImage;
            return members === undefined
              ? unknown("products")
              : (members[0]?.featured_image ?? null);
          },
          template_suffix: source.templateSuffix,
          default_sort_by: source.sortOrder,
          get sort_options() {
            return collectionSortOptions(source.sortOptions, `collections[${collectionIndex}]`);
          },
          results_count: null,
          terms: null,
          current_vendor: null,
          current_type: null,
          sort_by: route.sortBy,
          get filters() {
            if (members === undefined) return unknown("products (filters)");
            if (snapshot.filters === undefined) {
              absent("collection", "filters");
              return undefined;
            }
            if (
              snapshot.filters.some((filter) => filter.id === "filter.v.availability") &&
              source.products?.some((handle) =>
                productSources
                  .get(handle)
                  ?.variants.some((variant) => variant.available === undefined),
              )
            ) {
              absent("collection", "filters (variant.available)");
              return undefined;
            }
            return query()?.filters;
          },
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
        get: () => {
          if (snapshot.collections.some((collection) => collection.products === undefined)) {
            absent("product", "collections");
            return undefined;
          }
          return [...collections.values()].filter((collection) =>
            snapshot.collections
              .find((c) => c.handle === collection.handle)
              ?.products?.includes(source.handle),
          );
        },
      });
  }
  if (!collections.has("all")) {
    const collator =
      snapshot.shop.locale === undefined
        ? undefined
        : new Intl.Collator(snapshot.shop.locale, { sensitivity: "base" });
    const members = [...products.values()].sort(
      (a, b) => collator?.compare(String(a.title), String(b.title)) ?? 0,
    );
    const query = collectionQuery(
      "all",
      [...snapshot.products]
        .sort((a, b) => collator?.compare(a.title, b.title) ?? 0)
        .map((product) => product.handle),
      "title-ascending",
    );
    collections.set(
      "all",
      tracked(
        {
          id: null,
          handle: "all",
          get title() {
            if (snapshot.shop.locale === undefined) {
              absent("shop", "locale (collections.all.title)");
              return undefined;
            }
            if (snapshot.shop.locale.split("-")[0] !== "en")
              hooks.unsupportedOperation?.(
                "Localized automatic collection titles are unavailable; English is used.",
              );
            return "Products";
          },
          description: "",
          get products() {
            if (snapshot.shop.locale === undefined)
              absent("shop", "locale (collections.all product order; snapshot order retained)");
            return query()?.products;
          },
          get products_count() {
            return query()?.products.length;
          },
          all_products_count: members.length,
          get all_tags() {
            return memberValues(members, "tags");
          },
          get all_types() {
            return memberValues(members, "type");
          },
          get all_vendors() {
            return memberValues(members, "vendor");
          },
          url: "/collections/all",
          image: null,
          get featured_image() {
            return members[0]?.featured_image ?? null;
          },
          template_suffix: null,
          default_sort_by: "title-ascending",
          get sort_options() {
            return collectionSortOptions(undefined, "collections.all");
          },
          results_count: null,
          terms: null,
          current_vendor: null,
          current_type: null,
          sort_by: route.sortBy,
          get filters() {
            if (snapshot.filters === undefined) {
              absent("collection", "filters");
              return undefined;
            }
            if (
              snapshot.filters.some((filter) => filter.id === "filter.v.availability") &&
              snapshot.products.some((product) =>
                product.variants.some((variant) => variant.available === undefined),
              )
            ) {
              absent("collection", "filters (variant.available)");
              return undefined;
            }
            return query()?.filters;
          },
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
  // Configurable so that paginate can present one page of it.
  Object.defineProperty(collectionDictionary, Symbol.iterator, {
    value: () => listedCollections[Symbol.iterator](),
    configurable: true,
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
          metafields: metafields(source.metafields, `pages[${index}].metafields`),
        },
        "page",
        `pages[${index}]`,
      ),
    ]),
  );
  const articles = new Map<string, Map<string, LiquidRecord>>();
  /** Shopify lists a blog's articles newest first; equal publish times put the later-created (higher id) first. */
  function newestFirst<T extends { publishedAt?: string | undefined; id?: string | undefined }>(
    items: readonly T[],
  ) {
    const numeric = (value: string | undefined) =>
      value && /^\d+$/.test(value) ? BigInt(value) : null;
    const indexed = items.map((article, index) => ({ article, index }));
    if (items.some((article) => article.publishedAt === undefined)) return indexed;
    return indexed.sort((a, b) => {
      if (a.article.publishedAt === undefined || b.article.publishedAt === undefined) return 0;
      const time = Date.parse(b.article.publishedAt) - Date.parse(a.article.publishedAt);
      if (time) return time;
      const [x, y] = [numeric(a.article.id), numeric(b.article.id)];
      return x !== null && y !== null && x !== y ? (y > x ? 1 : -1) : 0;
    });
  }
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
          articles: newestFirst(source.articles).map(({ article, index }) => {
            const dto = tracked(
              {
                ...availableFields({
                  comments_count: article.commentsCount,
                  created_at: time(article.createdAt),
                  updated_at: time(article.updatedAt),
                  // A snapshot carries no comments, so the list is known only when there are none.
                  comments: article.commentsCount === 0 ? [] : undefined,
                }),
                ...availableFields({ id: article.id === undefined ? undefined : id(article.id) }),
                handle: article.handle,
                title: article.title,
                content: article.bodyHtml,
                excerpt: article.excerptHtml,
                author: article.author,
                ...availableFields({
                  published_at: time(article.publishedAt),
                  image: article.image
                    ? tracked(
                        {
                          ...image(article.image, `blogs[${blogIndex}].articles[${index}].image`),
                          ...availableFields({ id: sourceId(article.image.id) }),
                        },
                        "image",
                        `blogs[${blogIndex}].articles[${index}].image`,
                      )
                    : article.image,
                }),
                url: `/blogs/${source.handle}/${article.handle}`,
                tags: article.tags,
                template_suffix: article.templateSuffix,
                metafields: metafields(
                  article.metafields,
                  `blogs[${blogIndex}].articles[${index}].metafields`,
                ),
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
          metafields: metafields(source.metafields, `blogs[${blogIndex}].metafields`),
          ...availableFields({
            "comments_enabled?": source.commentsEnabled,
            "moderated?": source.commentsModerated,
          }),
        },
        "blog",
        `blogs[${blogIndex}]`,
      ),
    ]),
  );
  for (const source of snapshot.blogs) {
    const blog = blogs.get(source.handle);
    if (blog && source.articles.some((article) => article.publishedAt === undefined)) {
      const list = blog.articles;
      Object.defineProperty(blog, "articles", {
        enumerable: true,
        get() {
          absent("blog", "articles order (publishedAt); snapshot order retained");
          return list;
        },
      });
    }
  }
  const requestPath = localPath(route.path) ?? "/";
  function localPath(url: string): string | null {
    try {
      const parsed = new URL(url, "https://offline.invalid");
      if (![`offline.invalid`, snapshot.shop.domain].includes(parsed.host)) return null;
      return parsed.pathname.replace(/(.)\/$/, "$1");
    } catch {
      return null;
    }
  }
  /** Resources a menu link points at, found by its source URL. Other link types have no object. */
  function linkObject(link: MenuLink): unknown {
    if (link.resourceHandle === undefined) {
      absent("link", "resourceHandle");
      return undefined;
    }
    const path = localPath(link.url);
    let parts: string[] = [];
    try {
      parts = (path ?? "").split("/").slice(1).map(decodeURIComponent);
    } catch {
      parts = [];
    }
    const [namespace, handle = "", child = ""] = parts;
    const lookup: Record<string, () => unknown> = {
      product_link: () => (namespace === "products" ? products.get(handle) : undefined),
      collection_link: () => (namespace === "collections" ? collections.get(handle) : undefined),
      page_link: () => (namespace === "pages" ? pages.get(handle) : undefined),
      blog_link: () => (namespace === "blogs" && !child ? blogs.get(handle) : undefined),
      article_link: () => (namespace === "blogs" ? articles.get(handle)?.get(child) : undefined),
      policy_link: () => {
        const shop = globals.shop;
        const policies = shop && typeof shop === "object" ? Reflect.get(shop, "policies") : null;
        return Array.isArray(policies)
          ? policies.find((policy) => Reflect.get(policy, "url") === path)
          : undefined;
      },
    };
    if (link.type === "metaobject_link") {
      hooks.unsupportedOperation?.("Metaobject pages for menu links are not available offline.");
      return null;
    }
    const find = lookup[link.type];
    if (!find) return null;
    const value = find();
    if (value === undefined || value === null)
      hooks.missing?.(`Menu link ${link.title} references a resource absent from the snapshot.`);
    return value ?? null;
  }
  interface LinkState {
    record: LiquidRecord;
    active: boolean;
    current: boolean;
    levels: number;
    children: LinkState[];
  }
  function menuLinks(links: MenuLink[], path: string): LinkState[] {
    return links.map((link, index) => {
      const children = menuLinks(link.links, `${path}[${index}].links`);
      const target = localPath(link.url);
      // Shopify ignores URL parameters; a link is active on its own path and below it.
      const current = target !== null && target === requestPath;
      const active =
        current || (target !== null && target !== "/" && requestPath.startsWith(`${target}/`));
      const levels = children.length ? 1 + Math.max(...children.map((c) => c.levels)) : 0;
      const descendants = (states: LinkState[]): LinkState[] =>
        states.flatMap((state) => [state, ...descendants(state.children)]);
      const all = descendants(children);
      const record = tracked(
        {
          title: link.title,
          // Shopify derives a link's handle from its title; themes build element ids from it.
          handle: handleize(link.title),
          url: link.url,
          type: link.type,
          links: tracked(
            children.map((c) => c.record),
            "link",
            `${path}[${index}].links`,
          ),
          active,
          current,
          child_active: all.some((c) => c.active),
          child_current: all.some((c) => c.current),
          levels,
          get object() {
            return linkObject(link);
          },
          // Only Shopify's data-sale opt-out page link carries the privacy-choices icon.
          ...(target === "/pages/data-sharing-opt-out" ? {} : { data_sharing_opt_out_icon: null }),
        },
        "link",
        `${path}[${index}]`,
        {
          handle: "title",
          active: null,
          current: null,
          child_active: null,
          child_current: null,
          levels: null,
          object: "url",
          data_sharing_opt_out_icon: null,
        },
      );
      return { record, active, current, levels, children };
    });
  }
  const menuMap = Object.fromEntries(
    snapshot.menus.map((menu, index) => {
      const links = menuLinks(menu.links, `menus[${index}].links`);
      const record = {
        handle: menu.handle,
        title: menu.title,
        links: tracked(
          links.map((link) => link.record),
          "link",
          `menus[${index}].links`,
        ),
        levels: links.length ? 1 + Math.max(...links.map((link) => link.levels)) : 0,
      };
      // Shopify prints a menu as its handle, e.g. a link_list setting passed to an attribute.
      Object.defineProperty(record, Symbol.toPrimitive, { value: () => menu.handle });
      return [menu.handle, tracked(record, "linklist", `menus[${index}]`, { levels: null })];
    }),
  );
  /** `metaobjects.<type>.<handle>` lookup plus `values` and `values_count` per definition. */
  function metaobjectDefinitions(): LiquidRecord {
    const definitions = new Map<string, Map<string, object>>();
    for (const [index, source] of snapshot.metaobjects.entries()) {
      const path = `metaobjects[${index}]`;
      const entry = tracked(
        {
          ...Object.fromEntries(
            Object.entries(source.fields).map(([key, value]) => [
              key,
              typedMetafield(value)
                ? metafield(value.type, value.value, `${path}.fields.${key}`)
                : metafield(undefined, value, `${path}.fields.${key}`),
            ]),
          ),
          system: tracked(
            { type: source.type, handle: source.handle },
            "metaobject_system",
            `${path}`,
          ),
        },
        "metaobject",
        path,
        Object.fromEntries(Object.keys(source.fields).map((key) => [key, `fields.${key}`])),
      );
      let definition = definitions.get(source.type);
      if (!definition) {
        definition = new Map();
        definitions.set(source.type, definition);
      }
      definition.set(source.handle, entry);
    }
    // `values` and `values_count` are the definition's own properties; they win over handles
    // with the same name.
    return Object.fromEntries(
      [...definitions].map(([type, entries]) => [
        type,
        tracked(
          {
            ...Object.fromEntries(entries),
            values: [...entries.values()],
            values_count: entries.size,
          },
          "dictionary",
          `metaobjects.${type}`,
        ),
      ]),
    );
  }
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
    const variantPath = `products[${snapshot.products.indexOf(source)}].variants[${variantIndex}]`;
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
        ...availableFields({
          image:
            variantSource.image === undefined
              ? undefined
              : lineImage
                ? ((Array.isArray(product.images)
                    ? product.images[source.images.indexOf(lineImage)]
                    : null) ?? null)
                : product.featured_image,
        }),
        url: `/products/${source.handle}?variant=${encodeURIComponent(line.variantId)}`,
        options_with_values: tracked(
          variantSource.optionValues.map((value, valueIndex) =>
            tracked(
              { ...value },
              "option_with_value",
              `${variantPath}.optionValues[${valueIndex}]`,
            ),
          ),
          "option_with_value",
          `${variantPath}.optionValues`,
        ),
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
  // The selected country's currency supplies names when it is the shop currency.
  const shopCurrency = [
    ...(snapshot.localization?.availableCountries.filter(
      (country) => country.isoCode === snapshot.localization?.country,
    ) ?? []),
    ...(snapshot.localization?.availableCountries ?? []),
  ].find((country) => country.currency?.isoCode === snapshot.shop.currency)?.currency;
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
      currency: tracked(
        {
          iso_code: snapshot.shop.currency,
          symbol:
            shopCurrency?.symbol ??
            new Intl.NumberFormat("en", {
              style: "currency",
              currency: snapshot.shop.currency,
              currencyDisplay: "narrowSymbol",
            })
              .formatToParts(0)
              .find((part) => part.type === "currency")?.value ??
            snapshot.shop.currency,
          ...availableFields({ name: shopCurrency?.name }),
        },
        "currency",
        "shop",
        { iso_code: "currency", symbol: null, name: null },
      ),
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
        available: productAvailability(source.variants),
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
  const productSourceOf = new WeakMap<object, Snapshot["products"][number]>();
  for (const source of snapshot.products) {
    const value = products.get(source.handle);
    if (value) productSourceOf.set(value, source);
  }
  const resultSources = new WeakMap<object, Snapshot["products"][number]>();
  let results: LiquidRecord[] | undefined;
  function matching(): LiquidRecord[] | undefined {
    if (results) return results;
    const matches = searchResults(
      candidates,
      route.path,
      (message) =>
        hooks.unsupportedOperation
          ? hooks.unsupportedOperation(message)
          : hooks.unsupported("search", message),
      () => absent("search", "results (variant.available)"),
    );
    if (matches === undefined) return undefined;
    results = matches.map((candidate) => {
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
      const source = productSourceOf.get(candidate.value);
      if (source) resultSources.set(result, source);
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
        return matching()?.length;
      },
      default_sort_by: "relevance",
      sort_by: route.sortBy ?? "relevance",
      sort_options: [
        { name: "Relevance", value: "relevance" },
        { name: "Price, low to high", value: "price-ascending" },
        { name: "Price, high to low", value: "price-descending" },
      ].map((option) => tracked(option, "sort_option")),
      get filters() {
        if (snapshot.filters === undefined) {
          absent("search", "filters");
          return undefined;
        }
        const query = new URL(route.path, "https://offline.invalid").searchParams;
        if (
          snapshot.filters.some((filter) =>
            [...query.keys()].some((key) => key.startsWith(filter.id)),
          )
        )
          hooks.unsupportedOperation?.(
            "Storefront filters are not applied to search results offline.",
          );
        const matches = matching();
        if (matches === undefined) return undefined;
        if (
          snapshot.filters.some((filter) => filter.id === "filter.v.availability") &&
          matches.some((value) =>
            resultSources.get(value)?.variants.some((variant) => variant.available === undefined),
          )
        ) {
          absent("search", "filters (variant.available)");
          return undefined;
        }
        return storefrontQuery(
          snapshot,
          route.path,
          matches.flatMap((value) => {
            const source = resultSources.get(value);
            return source ? [{ source, value }] : [];
          }),
          {
            apply: false,
            sortBy: null,
            defaultSortBy: "relevance",
            track: tracked,
            unsupported: (message) => hooks.unsupportedOperation?.(message),
            missing: (message) =>
              hooks.missing ? hooks.missing(message) : hooks.unsupportedOperation?.(message),
          },
        ).filters;
      },
    },
    "search",
    "search",
  );
  const languages = (snapshot.localization?.availableLanguages ?? []).map((language, index) =>
    tracked(
      {
        iso_code: language.isoCode,
        direction: direction(language.isoCode),
        ...availableFields({
          name: language.name,
          endonym_name: language.endonymName,
          primary: language.primary,
          root_url: language.rootUrl,
        }),
      },
      "shop_locale",
      `localization.availableLanguages[${index}]`,
      {
        iso_code: "isoCode",
        direction: "isoCode",
        endonym_name: "endonymName",
        root_url: "rootUrl",
      },
    ),
  );
  let localization: LiquidRecord | undefined;
  if (snapshot.localization) {
    const source = snapshot.localization;
    const countries = source.availableCountries.map((country, index) =>
      tracked(
        {
          iso_code: country.isoCode,
          ...availableFields({
            name: country.name,
            currency: country.currency
              ? tracked(
                  {
                    iso_code: country.currency.isoCode,
                    ...availableFields({
                      symbol: country.currency.symbol,
                      name: country.currency.name,
                    }),
                  },
                  "currency",
                  `localization.availableCountries[${index}].currency`,
                  { iso_code: "isoCode" },
                )
              : undefined,
          }),
        },
        "country",
        `localization.availableCountries[${index}]`,
        { iso_code: "isoCode" },
      ),
    );
    localization = tracked(
      {
        available_countries: countries,
        available_languages: languages,
        country: countries.find((country) => country.iso_code === source.country),
        language: languages.find((language) => language.iso_code === source.language),
      },
      "localization",
      "localization",
      { available_countries: "availableCountries", available_languages: "availableLanguages" },
    );
  }
  // The request locale is the shop's language entry when the snapshot lists its languages.
  const requestLocale =
    languages.find((language) => language.iso_code === snapshot.shop.locale) ??
    tracked(
      {
        ...availableFields({
          iso_code: snapshot.shop.locale,
          direction:
            snapshot.shop.locale === undefined ? undefined : direction(snapshot.shop.locale),
        }),
        ...availableFields({
          name: undefined,
          endonym_name: undefined,
          primary: undefined,
          root_url: undefined,
        }),
      },
      "shop_locale",
      "shop",
      { iso_code: "locale", direction: "locale" },
    );
  const globals: LiquidRecord = {
    images: new ImageDirectory(snapshot.images, {
      read: hooks.read,
      unsupported: (property) => hooks.unsupported("image", property),
      missing: (property) => absent("image", property),
    }),
    shop: tracked(
      {
        ...Object.fromEntries(
          Object.entries(snapshot.shop).filter(
            ([key]) => !["seo", "permanentDomain", "socialSharingImage"].includes(key),
          ),
        ),
        ...availableFields({
          id: snapshot.shop.id === undefined ? undefined : id(snapshot.shop.id),
          permanent_domain: snapshot.shop.permanentDomain,
          name: snapshot.shop.name,
          locale: snapshot.shop.locale,
          money_format: snapshot.shop.money_format,
          money_with_currency_format: snapshot.shop.money_with_currency_format,
          // Optional shop metadata; an omission is missing data.
          description: snapshot.shop.description,
          customer_accounts_enabled: snapshot.shop.customer_accounts_enabled,
          customer_accounts_optional: snapshot.shop.customer_accounts_optional,
          enabled_payment_types: snapshot.shop.enabled_payment_types,
          features: snapshot.shop.features
            ? tracked(snapshot.shop.features, "shop.features", "shop.features")
            : undefined,
          policies: snapshot.shop.policies
            ? snapshot.shop.policies.map((source, index) => {
                class Policy extends Drop {
                  #field(key: "id" | "title" | "body" | "url") {
                    hooks.read(`shop.policies[${index}].${key}`);
                    if (!Object.hasOwn(source, key)) absent("policy", key);
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
                    if (!internalKeys.has(key)) hooks.unsupported("policy", key);
                    return undefined;
                  }
                }
                const policy = new Policy();
                objectKinds.set(policy, "policy");
                return policy;
              })
            : undefined,
        }),
        // Without a policy list, the policy aliases are missing data too.
        ...(snapshot.shop.policies
          ? {}
          : availableFields(Object.fromEntries(policyAliases.map((key) => [key, undefined])))),
        products_count: snapshot.products.length,
        collections_count: snapshot.collections.length,
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
    metaobjects: tracked(metaobjectDefinitions(), "dictionary", "metaobjects"),
    request: tracked(
      {
        path:
          route.pageType === "404" ? null : new URL(route.path, "https://offline.invalid").pathname,
        page_type: route.pageType,
        design_mode: route.designMode,
        visual_preview_mode: false,
        locale: requestLocale,
        host: snapshot.shop.domain,
        origin: `https://${snapshot.shop.domain}`,
      },
      "request",
      "request",
    ),
    // Derived paths, not snapshot reads: no source path is recorded for them.
    routes: tracked(
      { ...routePaths },
      "routes",
      "routes",
      Object.fromEntries(Object.keys(routePaths).map((key) => [key, null])),
    ),
  };
  if (localization) globals.localization = localization;
  else
    Object.defineProperty(globals, "localization", {
      enumerable: true,
      get() {
        if (hooks.missing) hooks.missing("Localization availability is absent from the snapshot.");
        else hooks.unsupportedOperation?.("Localization availability is absent from the snapshot.");
        return null;
      },
    });
  if (snapshot.shop.policies !== undefined) {
    const shop = globals.shop;
    if (
      shop !== null &&
      typeof shop === "object" &&
      "policies" in shop &&
      Array.isArray(shop.policies)
    ) {
      const policies = shop.policies;
      for (const key of policyAliases)
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
      // Metaobject pages are not rendered offline.
      metaobject: null,
    },
    "closest",
    "closest",
  );
  // Documented globals beyond the resources: nil where the preview has no such state, and a
  // diagnostic where the value exists on Shopify but not offline.
  Object.assign(globals, {
    articles: tracked(
      Object.fromEntries(
        [...articles].flatMap(([blog, entries]) =>
          [...entries].map(([handle, value]) => [`${blog}/${handle}`, value]),
        ),
      ),
      "dictionary",
      "articles",
    ),
    handle: route.resourceHandle,
    customer: null, // No customer session exists offline.
    self: null, // Metaobject templates are not rendered.
    current_tags: null, // Tag-filtered collection and blog URLs are not routed.
    // Product recommendations come from a separate storefront request; a page render has none.
    // Themes read `performed` as well as the documented `performed?`.
    recommendations: tracked(
      { "performed?": false, performed: false, products: [], products_count: 0, intent: null },
      "recommendations",
    ),
  });
  for (const [key, value, message] of [
    [
      "additional_checkout_buttons",
      false,
      "Accelerated checkout buttons are omitted; they require Shopify's live checkout.",
    ],
    [
      "content_for_additional_checkout_buttons",
      "",
      "Accelerated checkout buttons are omitted; they require Shopify's live checkout.",
    ],
  ] as const)
    Object.defineProperty(globals, key, {
      enumerable: true,
      get() {
        hooks.serverOnly?.(message);
        return value;
      },
    });
  for (const key of unavailableGlobals)
    Object.defineProperty(globals, key, {
      enumerable: true,
      get() {
        hooks.unsupportedOperation?.(`Global object ${key} is not available offline.`);
        return null;
      },
    });
  return globals;
}
