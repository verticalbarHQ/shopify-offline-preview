import { decodeHTML } from "entities";
import type { Liquid } from "liquidjs";
import { liquidObjectKind } from "../../../data/src/objects.js";
import type { Snapshot } from "../../../data/src/schema.js";
import { jsonString } from "./json.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function price(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid structured data price");
  const cents = BigInt(value);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export function registerStructuredDataFilter(
  engine: Liquid,
  shop: Snapshot["shop"],
  diagnostic: (code: string, message: string, file: string | null, line: number | null) => void,
): void {
  const strip = engine.filters.strip_html;
  if (typeof strip !== "function") throw new Error("Liquid strip_html filter is unavailable");
  engine.registerFilter("structured_data", function (value: unknown) {
    const kind = liquidObjectKind(value);
    if (!record(value) || !["product", "variant", "article"].includes(kind ?? "")) return "";
    const required = (object: Record<string, unknown>, property: string) => {
      if (!(property in object))
        diagnostic(
          "missing-resource",
          `Structured data source metadata ${property} is absent from the snapshot.`,
          this.token.file ?? null,
          this.token.getPosition()[0] ?? null,
        );
      return object[property];
    };
    const text = (html: unknown) => decodeHTML(String(strip.call(this, html) ?? html ?? ""));
    const absolute = (path: unknown) => new URL(String(path), `https://${shop.domain}`).href;
    const image = (input: unknown) => (record(input) ? `${input.src}?width=1920` : undefined);
    const offer = (variant: Record<string, unknown>) => ({
      "@id": `${variant.url}#offer`,
      "@type": "Offer",
      availability:
        required(variant, "available") === undefined
          ? undefined
          : `http://schema.org/${variant.available ? "InStock" : "OutOfStock"}`,
      price: price(variant.price),
      priceCurrency: shop.currency,
      url: absolute(variant.url),
    });
    const variantData = (variant: Record<string, unknown>, product: Record<string, unknown>) => ({
      "@id": `${variant.url}#variant`,
      "@type": "Product",
      image: image(
        required(variant, "featured_image") === null
          ? product.featured_image
          : variant.featured_image,
      ),
      name: variant.name,
      ...(variant.sku ? { sku: variant.sku } : {}),
      offers: offer(variant),
    });
    if (kind === "variant") {
      const product = value.product;
      return record(product) ? jsonString(variantData(value, product)) : "";
    }
    if (kind === "article")
      return jsonString({
        "@context": "http://schema.org/",
        "@id": `${value.url}#article`,
        "@type": "Article",
        mainEntityOfPage: { "@type": "WebPage", "@id": absolute(value.url) },
        articleBody: text(value.content),
        headline: value.title,
        description: text(value.excerpt),
        image: image(required(value, "image")),
        datePublished: required(value, "created_at"),
        dateModified: required(value, "published_at"),
        author: { "@type": "Person", name: value.author },
        publisher: { "@type": "Organization", name: required(shop, "name") },
      });
    const category = required(value, "category");
    const common = {
      "@context": "http://schema.org/",
      "@id": `${value.url}#product`,
      "@type": value.has_only_default_variant ? "Product" : "ProductGroup",
      brand: { "@type": "Brand", name: value.vendor },
      category: record(category) ? text(category.name) : value.type,
      description: text(value.description),
    };
    if (!Array.isArray(value.variants) || !value.variants.length)
      throw new Error("Structured data product has no variants");
    if (value.has_only_default_variant) {
      const variant = value.variants[0];
      if (!record(variant)) throw new Error("Invalid structured data variant");
      return jsonString({
        ...common,
        image: image(value.featured_image),
        name: value.title,
        ...(variant.sku ? { sku: variant.sku } : {}),
        offers: offer(variant),
        url: absolute(value.url),
      });
    }
    return jsonString({
      ...common,
      hasVariant: value.variants.map((variant) => {
        if (!record(variant)) throw new Error("Invalid structured data variant");
        return variantData(variant, value);
      }),
      name: value.title,
      productGroupID: required(value, "id")?.toString(),
      url: absolute(value.url),
    });
  });
}
