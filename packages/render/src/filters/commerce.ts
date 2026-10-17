import { type Liquid, toValue } from "liquidjs";
import { liquidObjectKind, liquidPrice } from "../../../data/src/objects.js";
import type { Snapshot } from "../../../data/src/schema.js";
import { namedArgs } from "./images.js";
import { jsonString } from "./json.js";
import { formatMoney } from "./money.js";

type Diagnostic = (code: string, message: string, file: string | null, line: number | null) => void;
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// metafield_tag types that render as one `<span class="metafield-<type>">` element.
const spanTypes = new Set([
  "boolean",
  "color",
  "multi_line_text_field",
  "number_decimal",
  "number_integer",
  "single_line_text_field",
]);

/**
 * Commerce display filters built from snapshot values. Markup follows Shopify's documentation;
 * details the documentation leaves open still need oracle verification.
 */
export function registerCommerceFilters(
  engine: Liquid,
  snapshot: Snapshot,
  diagnostic: Diagnostic,
): void {
  engine.registerFilter("unit_price_with_measurement", (input: unknown, measurement: unknown) => {
    const value: unknown = toValue(input);
    const price =
      typeof value === "string"
        ? value
        : formatMoney(Number(value ?? 0), snapshot.shop.money_format);
    const unit: unknown = toValue(measurement);
    if (!record(unit) || typeof unit.reference_unit !== "string")
      throw new Error("unit_price_with_measurement requires a unit price measurement");
    const reference = Number(unit.reference_value);
    return `${price}/${reference === 1 ? "" : reference}${unit.reference_unit}`;
  });
  engine.registerFilter("default_pagination", (input: unknown, ...args: unknown[]) => {
    if (liquidObjectKind(input) !== "paginate" || !record(input))
      throw new Error("default_pagination requires a paginate object");
    const options = namedArgs(args);
    const anchor = toValue(options.anchor);
    const link = (label: unknown, url: unknown) =>
      `<a href="${escapeHtml(`${String(url)}${anchor ? `#${String(anchor)}` : ""}`)}" title="">${String(label)}</a>`;
    const html: string[] = [];
    const previous = input.previous,
      next = input.next;
    if (record(previous))
      html.push(
        `<span class="prev">${link(toValue(options.previous) ?? "&laquo; Previous", previous.url)}</span>`,
      );
    for (const part of Array.isArray(input.parts) ? input.parts : []) {
      if (!record(part)) continue;
      if (part.is_link) html.push(`<span class="page">${link(part.title, part.url)}</span>`);
      else if (String(part.title) === String(input.current_page))
        html.push(`<span class="page current">${String(part.title)}</span>`);
      else html.push(`<span class="deco">${String(part.title)}</span>`);
    }
    if (record(next))
      html.push(
        `<span class="next">${link(toValue(options.next) ?? "Next &raquo;", next.url)}</span>`,
      );
    return html.join(" ");
  });
  engine.registerFilter("metafield_tag", function (input: unknown, ...args: unknown[]) {
    const report = (code: string, message: string) =>
      diagnostic(code, message, this.token.file ?? null, this.token.getPosition()[0] ?? null);
    if (liquidObjectKind(input) !== "metafield" || !record(input)) {
      report(
        "missing-resource",
        "metafield_tag needs a typed snapshot metafield ({type, value}); the plain value is output.",
      );
      return escapeHtml(toValue(input));
    }
    const type = String(input.type);
    if (spanTypes.has(type))
      return `<span class="metafield-${type}">${escapeHtml(input.value)}</span>`;
    const value = input.value;
    if (type === "url")
      return `<a class="metafield-url" href="${escapeHtml(value)}">${escapeHtml(value)}</a>`;
    if (type === "json")
      return `<script type="application/json" class="metafield-json">${jsonString(value)}</script>`;
    if (type === "money" && record(value) && typeof value.amount === "string")
      return `<span class="metafield-money">${formatMoney(liquidPrice(value.amount), snapshot.shop.money_with_currency_format)}</span>`;
    if (type === "list.single_line_text_field" && Array.isArray(value)) {
      const list = toValue(namedArgs(args).list_format) === "ordered" ? "ol" : "ul";
      return `<${list} class="metafield-single_line_text_field-array">${value
        .map((item) => `<li class="metafield-single_line_text_field">${escapeHtml(item)}</li>`)
        .join("")}</${list}>`;
    }
    report(
      "not-implemented",
      `metafield_tag output for metafield type ${type} is not implemented.`,
    );
    return `[not implemented: metafield_tag ${escapeHtml(type)}]`;
  });
}
