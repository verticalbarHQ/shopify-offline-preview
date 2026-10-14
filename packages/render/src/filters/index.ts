import { type Liquid, toValue } from "liquidjs";
import { ImageDirectory, MissingImage, NamedImageDrop } from "../../../data/src/images.js";
import { liquidObjectKind } from "../../../data/src/objects.js";
import type { Snapshot } from "../../../data/src/schema.js";
import { themePath } from "../../../theme/src/index.js";
import { registerFontFilters } from "../fonts.js";
import { formKind } from "../shopify-tags.js";
import { renderAnchor } from "./anchors.js";
import { registerCollectionLinkFilters } from "./collection-links.js";
import { registerColorFilters } from "./colors.js";
import { registerDateFilters } from "./dates.js";
import { registerEventFilters } from "./events.js";
import { handleize } from "./handle.js";
import { ImageUrlDrop, imageFilters, namedArgs } from "./images.js";
import { registerJsonFilter } from "./json.js";
import { md5 } from "./md5.js";
import { formatMoney, moneyAmount } from "./money.js";
import { registerStructuredDataFilter } from "./structured-data.js";
import { translateFactory } from "./translations.js";

interface FilterHooks {
  snapshot: Snapshot;
  files: Map<string, string>;
  paths: ReadonlySet<string>;
  readAsset(path: string): Promise<Uint8Array>;
  readData(path: string): void;
  sectionLocales(): unknown;
  diagnostic(code: string, message: string, file: string | null, line: number | null): void;
}
export function registerShopifyFilters(engine: Liquid, hooks: FilterHooks): void {
  for (const name of ["default", "size"] as const) {
    const native = engine.filters[name];
    if (typeof native !== "function") throw new Error(`Pinned LiquidJS ${name} filter unavailable`);
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      if (input instanceof MissingImage) return name === "default" ? args[0] : 0;
      if (
        (input instanceof NamedImageDrop ||
          input instanceof ImageDirectory ||
          input instanceof ImageUrlDrop) &&
        name === "default"
      )
        return input;
      if (input instanceof ImageDirectory && name === "size") return 0;
      return native.call(this, input, ...args);
    });
  }
  registerColorFilters(engine);
  registerCollectionLinkFilters(engine);
  registerJsonFilter(engine);
  registerStructuredDataFilter(engine, hooks.snapshot.shop, hooks.diagnostic);
  registerDateFilters(engine, hooks.snapshot, hooks.files, hooks.diagnostic);
  registerEventFilters(engine, hooks.snapshot.shop.currency, hooks.diagnostic);
  registerFontFilters(engine, hooks.diagnostic);
  engine.registerFilter("money_amount", (value) => moneyAmount(toValue(value)));
  engine.registerFilter("handleize", handleize);
  for (const name of ["payment_button", "payment_terms"])
    engine.registerFilter(name, function (value: unknown) {
      const kind = formKind(value);
      if (kind !== "product" && (name !== "payment_terms" || kind !== "cart"))
        throw new Error(`${name} requires a supported Shopify form`);
      hooks.diagnostic(
        "shopify-server-only",
        name === "payment_button"
          ? "Shopify accelerated checkout is omitted; it requires server-issued credentials and live checkout."
          : "Shop Pay installment terms are omitted; they require Shopify's live payment service.",
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      );
      return "";
    });
  engine.registerFilter("item_count_for_variant", (input: unknown, variant: unknown) => {
    if (
      liquidObjectKind(input) !== "cart" ||
      input === null ||
      typeof input !== "object" ||
      !("items" in input) ||
      !Array.isArray(input.items)
    )
      throw new Error("item_count_for_variant requires a cart");
    const selected = String(toValue(variant) ?? "");
    const count = input.items.reduce((total: bigint, item: unknown) => {
      if (
        item !== null &&
        typeof item === "object" &&
        "variant_id" in item &&
        "quantity" in item &&
        String(item.variant_id) === selected
      )
        return total + BigInt(Number(item.quantity));
      return total;
    }, 0n);
    if (count > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Cart item count exceeds safe numeric precision");
    return Number(count);
  });
  engine.registerFilter("link_to", (value: unknown, url: unknown, ...args: unknown[]) => {
    const target = String(toValue(url) ?? "");
    const attributes = namedArgs(args);
    if (!Object.keys(attributes).length) {
      attributes.href = target;
      attributes.title = "";
    } else attributes.href = target;
    try {
      const host = new URL(target, "https://offline.invalid").hostname;
      if (host === "shopify.com" || host.endsWith(".shopify.com")) attributes.rel = "nofollow";
    } catch {
      /* Relative or non-URL href strings still render as supplied. */
    }
    return renderAnchor(value, attributes);
  });
  const translate = translateFactory(hooks.files, hooks.snapshot.shop.locale, hooks.sectionLocales);
  engine.registerFilter("translate", function (value: unknown, ...args: unknown[]) {
    return translate(value, args, (key) =>
      hooks.diagnostic(
        "missing-resource",
        `Translation ${key} is missing.`,
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      ),
    );
  });
  for (const [name, withCurrency, withoutCurrency, withoutZeros] of [
    ["money", false, false, false],
    ["money_with_currency", true, false, false],
    ["money_without_currency", false, true, false],
    ["money_without_trailing_zeros", false, false, true],
  ] as const)
    engine.registerFilter(name, (value: unknown) => {
      const format = withCurrency
        ? hooks.snapshot.shop.money_with_currency_format
        : hooks.snapshot.shop.money_format;
      return formatMoney(value, format, withoutCurrency, withoutZeros);
    });
  engine.registerFilter("asset_url", function (value: unknown) {
    const path = themePath(`assets/${String(value ?? "")}`);
    if (!hooks.paths.has(path))
      hooks.diagnostic(
        "missing-resource",
        `Theme asset ${path} is missing.`,
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      );
    return `/sop/assets/${path.slice(7).split("/").map(encodeURIComponent).join("/")}`;
  });
  engine.registerFilter("inline_asset_content", async function (value: unknown) {
    if (typeof value !== "string") throw new Error("inline_asset_content requires an asset name");
    const path = themePath(`assets/${value}`);
    if (!/\.(?:svg|js|css)$/i.test(path))
      throw new Error("Only SVG, JS and CSS assets can be inlined");
    if (!hooks.paths.has(path)) {
      hooks.diagnostic(
        "missing-resource",
        `Theme asset ${path} is missing.`,
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      );
      throw new Error("Theme asset is missing");
    }
    const bytes = await hooks.readAsset(path);
    if (bytes.byteLength >= 15 * 1024) throw new Error("Inline asset must be smaller than 15 KB");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Inline asset must contain valid UTF-8 text");
    }
  });
  engine.registerFilter("preload_tag", function (value: unknown, ...args: unknown[]) {
    if (value instanceof ImageUrlDrop) value = toValue(value);
    if (typeof value !== "string" || !value) throw new Error("preload_tag requires an asset URL");
    const attributes = namedArgs(args);
    if (typeof attributes.as !== "string" || !attributes.as)
      throw new Error("preload_tag requires an as attribute");
    const output = [`href="${escapeAttribute(value)}"`];
    for (const [name, input] of Object.entries(attributes)) {
      if (!/^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(name))
        throw new Error("Invalid preload attribute name");
      if (name === "href" || name === "rel") continue;
      const scalar: unknown = toValue(input);
      if (scalar === null || scalar === undefined || scalar === false) continue;
      output.push(scalar === true ? name : `${name}="${escapeAttribute(scalar)}"`);
    }
    hooks.diagnostic(
      "shopify-server-only",
      "Shopify's HTTP Link preload header is omitted from the HTML render result.",
      this.token.file ?? null,
      this.token.getPosition()[0] ?? null,
    );
    return `<link ${output.join(" ")} rel="preload">`;
  });
  engine.registerFilter("md5", (value: unknown) => md5(String(toValue(value) ?? "")));
  const images = imageFilters(hooks.snapshot, hooks.readData);
  engine.registerFilter("image_url", function (value: unknown, ...args: unknown[]) {
    return images.imageUrl(value, args, (message) =>
      hooks.diagnostic(
        "not-implemented",
        message,
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      ),
    );
  });
  engine.registerFilter("image_tag", function (value: unknown, ...args: unknown[]) {
    return images.imageTag(value, args, (message) =>
      hooks.diagnostic(
        "not-implemented",
        message,
        this.token.file ?? null,
        this.token.getPosition()[0] ?? null,
      ),
    );
  });
  engine.registerFilter(
    "stylesheet_tag",
    (value: unknown) =>
      `<link href="${escapeAttribute(value)}" rel="stylesheet" type="text/css" media="all" />`,
  );
  engine.registerFilter(
    "script_tag",
    (value: unknown) => `<script src="${escapeAttribute(value)}" type="text/javascript"></script>`,
  );
}
function escapeAttribute(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
