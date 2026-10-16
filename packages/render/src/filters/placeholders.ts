import { type Liquid, toValue } from "liquidjs";
import { parseFragment } from "parse5";
import { placeholderNames } from "../../../data/src/placeholders.js";
import type { Snapshot } from "../../../data/src/schema.js";
import { liquidFilterText } from "./core-language.js";
import { namedArgs } from "./images.js";

interface Hooks {
  read(path: string): void;
  diagnostic(code: string, message: string, file: string | null, line: number | null): void;
}
interface SvgTemplate {
  text: string;
  insertAt: number;
}
function template(text: string): SvgTemplate {
  const errors: string[] = [];
  const fragment = parseFragment(text, {
    sourceCodeLocationInfo: true,
    onParseError(error) {
      errors.push(error.code);
    },
  });
  const roots = fragment.childNodes.filter(
    (node) => node.nodeName !== "#comment" && !("value" in node && !node.value.trim()),
  );
  const root = roots[0];
  if (
    errors.length ||
    roots.length !== 1 ||
    !root ||
    !("tagName" in root) ||
    root.tagName !== "svg"
  )
    throw new Error("Local placeholder data must contain one complete SVG element");
  const location = root.sourceCodeLocation;
  if (
    !location?.startTag ||
    (!location.endTag &&
      !text.slice(location.startTag.startOffset, location.startTag.endOffset).endsWith("/>"))
  )
    throw new Error("Local placeholder data must contain one complete SVG element");
  if (root.attrs.some((attr) => attr.name === "class"))
    throw new Error("Local placeholder data must be the SVG output without a class argument");
  const namespace = root.attrs.find((attr) => attr.name === "xmlns");
  if (namespace && namespace.value !== "http://www.w3.org/2000/svg")
    throw new Error("Local placeholder data has an invalid SVG namespace");
  return { text, insertAt: location.startTag.startOffset + 4 };
}
function blank(input: unknown): boolean {
  const value: unknown = toValue(input);
  if (value === null || value === undefined || value === false) return true;
  if (Array.isArray(value)) return !value.length;
  if (typeof value === "string")
    return /^[\t\n\r\f\v \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(
      value,
    );
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return !Object.keys(value).length;
  return false;
}
/** Consumes externally prepared local SVG data; the renderer never fetches platform artwork. */
export function registerPlaceholderFilter(engine: Liquid, snapshot: Snapshot, hooks: Hooks): void {
  const names: ReadonlySet<string> = new Set(placeholderNames);
  const cache = new Map<string, SvgTemplate>();
  engine.registerFilter("placeholder_svg_tag", function (input: unknown, cssClass?: unknown) {
    const value: unknown = toValue(input);
    if (value === null || value === undefined) throw new Error("Missing SVG placeholder");
    const name = liquidFilterText(value);
    if (!names.has(name)) throw new Error(`Unknown SVG placeholder '${name}'`);
    // Read from the validated catalog without requiring all known names in every snapshot.
    const catalog: Readonly<Record<string, string>> = snapshot.placeholderSvgs ?? {};
    hooks.read(`placeholderSvgs.${name}`);
    const svg = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
    if (svg === undefined) {
      hooks.diagnostic(
        "missing-resource",
        `Local SVG data for placeholder ${name} is missing.`,
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      );
      return "";
    }
    const classes = blank(cssClass) ? "" : liquidFilterText(cssClass);
    this.context.memoryLimit.use(svg.length + classes.length);
    let asset = cache.get(name);
    if (!asset) {
      asset = template(svg);
      cache.set(name, asset);
    }
    // Shopify inserts the supplied class text verbatim. Preserve the supplied artwork bytes.
    return classes
      ? `${asset.text.slice(0, asset.insertAt)} class="${classes}"${asset.text.slice(asset.insertAt)}`
      : asset.text;
  });
}

/** Payment icons are platform artwork too: the snapshot supplies their SVGs by payment type. */
export function registerPaymentTypeFilter(engine: Liquid, snapshot: Snapshot, hooks: Hooks): void {
  const cache = new Map<string, SvgTemplate>();
  engine.registerFilter("payment_type_svg_tag", function (input: unknown, ...args: unknown[]) {
    const type = liquidFilterText(toValue(input) ?? "");
    const catalog: Readonly<Record<string, string>> = snapshot.paymentTypeSvgs ?? {};
    hooks.read(`paymentTypeSvgs.${type}`);
    const svg = Object.hasOwn(catalog, type) ? catalog[type] : undefined;
    if (svg === undefined) {
      hooks.diagnostic(
        "missing-resource",
        `Local SVG data for payment type ${type} is missing.`,
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      );
      return "";
    }
    const cssClass: unknown = toValue(namedArgs(args).class);
    const classes = blank(cssClass) ? "" : liquidFilterText(cssClass);
    this.context.memoryLimit.use(svg.length + classes.length);
    let asset = cache.get(type);
    if (!asset) {
      asset = template(svg);
      cache.set(type, asset);
    }
    return classes
      ? `${asset.text.slice(0, asset.insertAt)} class="${classes}"${asset.text.slice(asset.insertAt)}`
      : asset.text;
  });
}
