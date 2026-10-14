import { type Liquid, toValue } from "liquidjs";
import { ImageDirectory, MissingImage } from "../../../data/src/images.js";
import { liquidObjectKind } from "../../../data/src/objects.js";

/** Safe inside a script element, matching Shopify's JSON escaping. */
export function jsonString(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(
    /[<>&/\u2028\u2029]/g,
    (c) =>
      ({
        "<": "\\u003c",
        ">": "\\u003e",
        "&": "\\u0026",
        "/": "\\/",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
      })[c] ?? c,
  );
}
const productFields = [
  "id",
  "title",
  "handle",
  "description",
  "published_at",
  "created_at",
  "vendor",
  "type",
  "tags",
  "price",
  "price_min",
  "price_max",
  "available",
  "price_varies",
  "compare_at_price",
  "compare_at_price_min",
  "compare_at_price_max",
  "compare_at_price_varies",
  "variants",
  "images",
  "featured_image",
  "options",
  "media",
  "requires_selling_plan",
  "selling_plan_groups",
  "content",
];
const variantFields = [
  "id",
  "title",
  "option1",
  "option2",
  "option3",
  "sku",
  "requires_shipping",
  "taxable",
  "featured_image",
  "available",
  "name",
  "public_title",
  "options",
  "price",
  "weight",
  "compare_at_price",
  "inventory_management",
  "barcode",
  "requires_selling_plan",
  "selling_plan_allocations",
  "quantity_rule",
];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function project(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
  );
}
export function registerJsonFilter(engine: Liquid) {
  engine.registerFilter("json", (input: unknown) => {
    if (input instanceof MissingImage || input instanceof ImageDirectory)
      return jsonString({ error: "json not allowed for this object" });
    const output = JSON.stringify(toValue(input) ?? null, (_key, value: unknown) => {
      if (!record(value)) return value;
      const kind = liquidObjectKind(value);
      if (kind === "variant") return project(value, variantFields);
      if (kind === "product") {
        const product = project(value, productFields);
        if (Array.isArray(product.images))
          product.images = product.images.map((item: unknown) => (record(item) ? item.src : item));
        if (record(product.featured_image)) product.featured_image = product.featured_image.src;
        // Shopify serializes absent compare-at bounds as zero and excludes inventory policies/quantities.
        product.compare_at_price_min ??= 0;
        product.compare_at_price_max ??= 0;
        return product;
      }
      return value;
    });
    return jsonString(JSON.parse(output ?? "null"));
  });
}
