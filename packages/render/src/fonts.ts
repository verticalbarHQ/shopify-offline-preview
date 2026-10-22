import { Drop, type Liquid } from "liquidjs";
import { namedArgs } from "./filters/images.js";

interface Family {
  name: string;
  fallback: string;
  fallbackByWeight?: Record<number, string>;
  system?: boolean;
  unsuffixed?: boolean;
  weights: number[];
  normal: Record<number, string>;
  italic: Record<number, string>;
  oblique?: Record<number, string>;
}
const range = (first: number, last: number) =>
  Array.from({ length: (last - first) / 100 + 1 }, (_, i) => first + i * 100);
const urls = (weights: number[], path: string) =>
  Object.fromEntries(weights.map((weight) => [weight, `https://fonts.gstatic.com/s/${path}`]));
const metadataOnly = (weights: number[]) =>
  Object.fromEntries(weights.map((weight) => [weight, ""]));
function systemFamily(name: string, fallback: string, unsuffixed = false): Family {
  const weights = unsuffixed ? [400] : [400, 700];
  return {
    name,
    fallback,
    system: true,
    unsuffixed,
    weights,
    normal: metadataOnly(weights),
    italic: unsuffixed ? {} : metadataOnly(weights),
  };
}
const families: Record<string, Family> = {
  // Shopify's published catalogues, checked 2026-10-23:
  // https://shopify.dev/json/shopify_font_families.json
  // https://shopify.dev/json/shopify_font_deprecated.json
  // These are setting metadata, not a claim that a face is installed on the host.
  mono: systemFamily(
    '"SF Mono"',
    "Menlo, Consolas, Monaco, Liberation Mono, Lucida Console, monospace, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol",
    true,
  ),
  serif: systemFamily(
    '"New York"',
    "Iowan Old Style, Apple Garamond, Baskerville, Times New Roman, Droid Serif, Times, Source Serif Pro, serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol",
    true,
  ),
  "sans-serif": systemFamily(
    "-apple-system",
    "BlinkMacSystemFont, Segoe UI, Roboto, Ubuntu, Helvetica Neue, sans-serif, Apple Color Emoji, Segoe UI Emoji, Segoe UI Symbol",
    true,
  ),
  sans_serif: systemFamily("Helvetica", "Arial, sans-serif"),
  arial: systemFamily("Arial", "sans-serif"),
  courier_new: systemFamily('"Courier New"', "Courier, monospace"),
  garamond: systemFamily("Garamond", "Baskerville, Caslon, serif"),
  lucida_grande: systemFamily(
    '"Lucida Grande"',
    "'Lucida Sans Unicode', 'Lucida Sans', Lucida, Helvetica, Arial, sans-serif",
  ),
  monaco: systemFamily("Monaco", "'Lucida Console', 'DejaVu Sans Mono', monospace"),
  palatino: systemFamily("Palatino", "'Palatino Linotype', 'Book Antiqua', serif"),
  system_ui: systemFamily(
    "system_ui",
    "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', 'Liberation Sans', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'",
  ),
  times_new_roman: systemFamily('"Times New Roman"', "Times, serif"),
  trebuchet_ms: systemFamily('"Trebuchet MS"', "sans-serif"),
  // This historical Monotype selection is NOT the system sans_serif setting.
  // Preserve its metadata without replacing it or inventing a captured CDN URL.
  helvetica: {
    name: "Helvetica",
    fallback: "'Helvetica Neue', Arial, 'Lucida Grande', sans-serif",
    fallbackByWeight: { 300: "sans-serif", 900: "sans-serif" },
    weights: [300, 400, 700, 900],
    normal: metadataOnly([300, 400, 700, 900]),
    italic: {},
    oblique: metadataOnly([300, 400, 700, 900]),
  },
  // Existing best-effort Latin substitutes from Google CSS2 (2026-10-14).
  // URL metadata only; the renderer never fetches a font or stylesheet.
  inter: {
    name: "Inter",
    fallback: "sans-serif",
    weights: range(100, 900),
    normal: urls(range(100, 900), "inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2"),
    italic: urls(range(100, 900), "inter/v20/UcC53FwrK3iLTcvneQg7Ca725JhhKnNqk6L5UUM.woff2"),
  },
  assistant: {
    name: "Assistant",
    fallback: "sans-serif",
    weights: range(200, 800),
    normal: urls(range(200, 800), "assistant/v24/2sDcZGJYnIjSi6H75xkzaGW5.woff2"),
    italic: {},
  },
  work_sans: {
    name: '"Work Sans"',
    fallback: "sans-serif",
    weights: range(100, 900),
    normal: urls(range(100, 900), "worksans/v24/QGYsz_wNahGAdqQ43Rh_fKDp.woff2"),
    italic: urls(range(100, 900), "worksans/v24/QGYqz_wNahGAdqQ43Rh_eZDrv_0.woff2"),
  },
  anonymous_pro: {
    name: '"Anonymous Pro"',
    fallback: "monospace",
    weights: [400, 700],
    normal: {
      400: "https://fonts.gstatic.com/s/anonymouspro/v22/rP2Bp2a15UIB7Un-bOeISG3pHls29Q.woff2",
      700: "https://fonts.gstatic.com/s/anonymouspro/v22/rP2cp2a15UIB7Un-bOeISG3pFuAT4C7c7Q.woff2",
    },
    italic: {
      400: "https://fonts.gstatic.com/s/anonymouspro/v22/rP2fp2a15UIB7Un-bOeISG3pHl4G9wn5.woff2",
      700: "https://fonts.gstatic.com/s/anonymouspro/v22/rP2ap2a15UIB7Un-bOeISG3pHl4OTCzs74u2.woff2",
    },
  },
};
const internal = new Set([
  "then",
  "next",
  "toLiquid",
  "toJSON",
  "constructor",
  "__proto__",
  "prototype",
]);

export class Font extends Drop {
  #definition: Family;
  #unsupported: (message: string) => void;
  constructor(
    readonly handle: string,
    readonly weight: number,
    readonly style: "normal" | "italic" | "oblique",
    definition: Family,
    unsupported: (message: string) => void,
  ) {
    super();
    this.#definition = definition;
    this.#unsupported = unsupported;
  }
  get family() {
    return this.#definition.name;
  }
  get fallback_families() {
    return this.#definition.fallbackByWeight?.[this.weight] ?? this.#definition.fallback;
  }
  get "system?"() {
    return this.#definition.system === true;
  }
  get variants() {
    return ["normal", "italic", "oblique"].flatMap((style) =>
      this.#definition.weights.flatMap((weight) => {
        const font = this.modify("style", style)?.modify("weight", weight);
        return font ? [font] : [];
      }),
    );
  }
  valueOf() {
    if (this.#definition.unsuffixed) return this.handle;
    return `${this.handle}_${this.style[0]}${this.weight / 100}`;
  }
  liquidMethodMissing(key: string) {
    if (!internal.has(key)) this.#unsupported(`Font property ${key} is not available offline.`);
    return undefined;
  }
  modify(property: unknown, input: unknown): Font | null {
    let weight = this.weight,
      style = this.style;
    if (property === "style") {
      if (input !== "normal" && input !== "italic" && input !== "oblique") return null;
      style = input;
    } else if (property === "weight") {
      if (input === "normal") weight = 400;
      else if (input === "bold") weight = 700;
      else if (input === "bolder") weight = weight < 350 ? 400 : weight < 550 ? 700 : 900;
      else if (input === "lighter") weight = weight < 550 ? 100 : weight < 750 ? 400 : 700;
      else if (typeof input === "string" && /^[+-][1-9]00$/.test(input)) weight += Number(input);
      else if (/^[1-9]00$/.test(String(input))) weight = Number(input);
      else return null;
    } else return null;
    const variants = this.#definition[style];
    if (!variants || !Object.hasOwn(variants, weight)) return null;
    return new Font(this.handle, weight, style, this.#definition, this.#unsupported);
  }
  url() {
    return this.#definition[this.style]?.[this.weight] ?? "";
  }
}

export function fontSetting(input: unknown, unsupported: (message: string) => void): Font | null {
  if (input instanceof Font) return input;
  if (!input) return null;
  const match = typeof input === "string" ? /^(\w+)_([nio])([1-9])$/.exec(input) : null;
  const handle = match?.[1] ?? (typeof input === "string" ? input : "");
  const definition = Object.hasOwn(families, handle) ? families[handle] : undefined;
  const weight = definition?.unsuffixed && !match ? 400 : Number(match?.[3]) * 100;
  const style = match?.[2] === "i" ? "italic" : match?.[2] === "o" ? "oblique" : "normal";
  const variants = definition?.[style];
  if (
    !definition ||
    (definition.unsuffixed && match) ||
    !variants ||
    !Object.hasOwn(variants, weight)
  ) {
    unsupported("Selected font has no supported offline metadata or Google Fonts mapping.");
    return null;
  }
  return new Font(handle, weight, style, definition, unsupported);
}

export function registerFontFilters(
  engine: Liquid,
  diagnostic: (code: string, message: string, file: string | null, line: number | null) => void,
): void {
  engine.registerFilter("font_modify", (font: unknown, property: unknown, value: unknown) =>
    font instanceof Font ? font.modify(property, value) : null,
  );
  for (const name of ["font_face", "font_url"]) {
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      if (!(input instanceof Font)) return "";
      const file = this.token.file ?? null,
        line = this.token.getPosition()[0] ?? null;
      const options = namedArgs(args);
      if (input["system?"]) return "";
      if (!input.url()) {
        diagnostic(
          "missing-resource",
          `Font ${input.valueOf()} has no captured font file; only its CSS family and fallback stack are available.`,
          file,
          line,
        );
        return "";
      }
      diagnostic(
        "shopify-server-only",
        "Shopify font CDN is replaced with a best-effort Google Fonts Latin subset; offline the fallback stack applies.",
        file,
        line,
      );
      if (name === "font_url") {
        if (options.format !== undefined && options.format !== "woff2") {
          diagnostic(
            "shopify-server-only",
            "The font substitute is available only as WOFF2.",
            file,
            line,
          );
          return "";
        }
        return input.url();
      }
      const display = options.font_display;
      if (
        display !== undefined &&
        !["auto", "block", "swap", "fallback", "optional"].includes(String(display))
      )
        throw new Error("Invalid font_display value");
      return `@font-face {\n  font-family: ${input.family};\n  font-weight: ${input.weight};\n  font-style: ${input.style};\n${display === undefined ? "" : `  font-display: ${display};\n`}  src: url("${input.url()}") format("woff2");\n}`;
    });
  }
}
