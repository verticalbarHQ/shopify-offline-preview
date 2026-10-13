import type { Liquid } from "liquidjs";
import { liquidObjectKind } from "../../../data/src/objects.js";
import { namedArgs } from "./images.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decimal(amount: unknown): string {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount))
    throw new Error("Invalid event price");
  const cents = BigInt(amount);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0").replace(/0+$/, "") || "0"}`;
}
function serialize(value: unknown) {
  return JSON.stringify(value).replace(
    /[<>&/]/g,
    (character) =>
      ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "/": "\\/" })[character] ?? character,
  );
}
export function registerEventFilters(
  engine: Liquid,
  currency: string,
  diagnostic: (code: string, message: string, file: string | null, line: number | null) => void,
): void {
  engine.registerFilter(
    "standard_event_data",
    function (value: unknown, event: unknown, ...args: unknown[]) {
      if (event !== "view") throw new Error("standard_event_data supports only the view event");
      const kind = liquidObjectKind(value);
      if (!record(value) || !["product", "collection", "cart"].includes(kind ?? ""))
        throw new Error("standard_event_data supports only product, collection and cart objects");
      if (kind === "collection") {
        // An all-products collection has no persistent Shopify collection ID.
        const id = Object.hasOwn(value, "id") ? value.id : null;
        return serialize({
          collection: { id, handle: value.handle, productsCount: value.products_count },
        });
      }
      const context = namedArgs(args).context ?? null;
      const validContexts =
        kind === "product"
          ? ["page", "search", "collection", "dialog", "recommendation"]
          : ["page", "dialog"];
      if (context !== null && !validContexts.includes(String(context)))
        throw new Error("Unsupported standard_event_data context");
      if (kind === "cart") {
        diagnostic(
          "shopify-server-only",
          "Shopify cart session identity is unavailable; the view payload omits the server cart while the page renders snapshot lines.",
          this.token.file ?? null,
          this.token.getPosition()[0] ?? null,
        );
        return serialize({ context, cart: null });
      }
      const selected = value.selected_variant;
      const options = Array.isArray(value.options_with_values) ? value.options_with_values : [];
      const selectedValues =
        record(selected) && Array.isArray(selected.options) ? selected.options : null;
      const selectedOptions = selectedValues
        ? options.map((option, index) => ({
            name: record(option) ? option.name : "",
            value: selectedValues[index],
          }))
        : [];
      const selectedVariant = record(selected)
        ? {
            id: selected.id,
            title: selected.title,
            availableForSale: selected.available,
            price: { amount: decimal(selected.price), currencyCode: currency },
            selectedOptions,
          }
        : null;
      const id = Object.hasOwn(value, "id") ? value.id : null;
      return serialize({
        product: { id, title: value.title, handle: value.handle, selectedVariant },
        context,
        selectedOptions,
      });
    },
  );
}
