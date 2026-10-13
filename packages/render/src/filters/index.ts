import { type Liquid, toValue } from "liquidjs";
import type { Snapshot } from "../../../data/src/schema.js";
import { themePath } from "../../../theme/src/index.js";
import { imageFilters } from "./images.js";
import { md5 } from "./md5.js";
import { formatMoney } from "./money.js";
import { translateFactory } from "./translations.js";

interface FilterHooks {
  snapshot: Snapshot;
  files: Map<string, string>;
  paths: ReadonlySet<string>;
  readAsset(path: string): Promise<Uint8Array>;
  sectionLocales(): unknown;
  diagnostic(code: string, message: string, file: string | null, line: number | null): void;
}
export function registerShopifyFilters(engine: Liquid, hooks: FilterHooks): void {
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
  engine.registerFilter("md5", (value: unknown) => md5(String(toValue(value) ?? "")));
  const images = imageFilters(hooks.snapshot);
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
  engine.registerFilter("image_tag", (value: unknown, ...args: unknown[]) =>
    images.imageTag(value, args),
  );
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
