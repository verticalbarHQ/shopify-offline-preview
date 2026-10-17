import { type Liquid, toValue } from "liquidjs";
import { ColorValue, colorSetting } from "../color-settings.js";
import { LiquidFloat } from "../numbers.js";

/** Preserves the float's display while arithmetic and comparisons still use a number. */
class DecimalNumber extends LiquidFloat {
  constructor(
    value: number,
    readonly digits: number,
  ) {
    super(value);
  }
  [Symbol.toPrimitive](hint: string) {
    return hint === "string" ? this.valueOf().toFixed(this.digits) : this.valueOf();
  }
}
function channels(value: unknown): ColorValue {
  const parsed = colorSetting(value, () => {});
  if (!(parsed instanceof ColorValue)) throw new Error("Unsupported color input");
  return parsed;
}
function exactHsl(color: ColorValue) {
  const r = color.red / 255,
    g = color.green / 255,
    b = color.blue / 255,
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min,
    l = (max + min) / 2;
  let h = 0;
  if (d !== 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60 + 360) % 360) / 360, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}
/**
 * HSL (each 0 to 1) to RGB with the W3C hue-to-RGB steps. Callers do their HSL arithmetic in
 * degrees and percentages, as Shopify does: measured outputs at exact halves depend on it.
 */
function fromHsl(h: number, s: number, l: number, alpha: number): ColorValue {
  const m2 = l <= 0.5 ? l * (s + 1) : l + s - l * s,
    m1 = l * 2 - m2;
  const hue = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x * 6 < 1) return m1 + (m2 - m1) * x * 6;
    if (x * 2 < 1) return m2;
    if (x * 3 < 2) return m1 + (m2 - m1) * (2 / 3 - x) * 6;
    return m1;
  };
  const [r, g, b] = [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255));
  return new ColorValue(r ?? 0, g ?? 0, b ?? 0, alpha, () => {});
}
/** HSL in degrees and percentages. */
function hslUnits(color: ColorValue) {
  const { h, s, l } = exactHsl(color);
  return { h: h * 360, s: s * 100, l: l * 100 };
}
function fromHslUnits(h: number, s: number, l: number, alpha: number): ColorValue {
  return fromHsl(h / 360, s / 100, l / 100, alpha);
}
function percent(value: unknown) {
  const amount = Number(toValue(value));
  if (!Number.isFinite(amount) || amount < 0 || amount > 100)
    throw new Error("Color percentage must be between 0 and 100");
  return amount;
}
function luminance(color: ColorValue) {
  const linear = (channel: number) => {
    const x = channel / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return linear(color.red) * 0.2126 + linear(color.green) * 0.7152 + linear(color.blue) * 0.0722;
}
function modifiedColor(input: unknown, color: ColorValue): string {
  if (color.alpha !== 1) return `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha})`;
  return /^rgba?\(/i.test(String(toValue(input)))
    ? `rgb(${color.red}, ${color.green}, ${color.blue})`
    : color.valueOf();
}
type ColorFormat = "hex" | "rgb" | "hsl";
interface ParsedColor {
  color: ColorValue;
  format: ColorFormat;
  /** The HSL components (degrees and percentages) when the input was written as hsl(). */
  hsl?: { h: number; s: number; l: number };
}
function parsedColor(value: unknown): ParsedColor {
  const text = String(toValue(value) ?? "")
    .trim()
    .toLowerCase();
  const hsl = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    text,
  );
  if (hsl) {
    // CSS hues wrap around: 720 is 0 and 400 is 40.
    const h = Number(hsl[1]) % 360,
      s = Number(hsl[2]),
      l = Number(hsl[3]),
      alpha = hsl[4] === undefined ? 1 : Number(hsl[4]);
    return { color: fromHslUnits(h, s, l, alpha), format: "hsl", hsl: { h, s, l } };
  }
  return { color: channels(value), format: /^rgba?\(/.test(text) ? "rgb" : "hex" };
}
/** Alpha as Shopify prints it: rounded to two decimals. */
function alphaText(alpha: number): string {
  return String(Math.round(alpha * 100) / 100);
}
function hslText(h: number, s: number, l: number, alpha: number): string {
  const parts = `${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(l)}%`;
  return alpha === 1 ? `hsl(${parts})` : `hsla(${parts}, ${alphaText(alpha)})`;
}
function colorText(color: ColorValue, format: ColorFormat): string {
  if (format === "hsl") {
    const { h, s, l } = hslUnits(color);
    return hslText(h, s, l, color.alpha);
  }
  if (color.alpha !== 1)
    return `rgba(${color.red}, ${color.green}, ${color.blue}, ${alphaText(color.alpha)})`;
  return format === "rgb"
    ? `rgb(${color.red}, ${color.green}, ${color.blue})`
    : new ColorValue(color.red, color.green, color.blue, 1, () => {}).valueOf();
}
/** Ruby's Float#to_s for the short values Shopify prints, such as 0.2 and 1.0. */
function rubyFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
function oklch(color: ColorValue): string {
  const linear = (channel: number) => {
    const x = channel / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(color.red),
    g = linear(color.green),
    b = linear(color.blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.sqrt(a * a + bb * bb);
  const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return `oklch(${Math.round(lightness * 100)}% ${rubyFloat(Math.round(chroma * 100) / 100)} ${Math.round(hue) % 360} / ${rubyFloat(Math.round(color.alpha * 100) / 100)})`;
}
function brightness(color: ColorValue): number {
  return (299 * color.red + 587 * color.green + 114 * color.blue) / 1000;
}
function saturationAmount(value: unknown, label: string): number {
  const scalar: unknown = toValue(value);
  const amount = Number(scalar);
  if (
    (typeof scalar !== "number" && typeof scalar !== "string" && !(scalar instanceof Number)) ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > 100
  )
    throw new Error(`${label} amount must be a numeric value between 0 and 100`);
  return amount;
}
export function registerColorFilters(engine: Liquid): void {
  engine.registerFilter("color_modify", (input: unknown, component: unknown, amount: unknown) => {
    const color = channels(input),
      key = String(component),
      scalar = toValue(amount),
      value = Number(scalar);
    const maximum =
      key === "alpha"
        ? 1
        : key === "hue"
          ? 360
          : ["saturation", "lightness"].includes(key)
            ? 100
            : 255;
    if (!["red", "green", "blue", "alpha", "hue", "saturation", "lightness"].includes(key))
      throw new Error("Unsupported color component");
    if (
      (typeof scalar !== "number" && typeof scalar !== "string" && !(scalar instanceof Number)) ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > maximum ||
      (key !== "alpha" && !Number.isInteger(value))
    )
      throw new Error(
        `${key[0]?.toUpperCase()}${key.slice(1)} must be ${key === "alpha" ? "a number" : "an integer"} between 0 and ${maximum}`,
      );
    let result: ColorValue;
    if (["hue", "saturation", "lightness"].includes(key)) {
      const hsl = hslUnits(color);
      result = fromHslUnits(
        key === "hue" ? value : hsl.h,
        key === "saturation" ? value : hsl.s,
        key === "lightness" ? value : hsl.l,
        color.alpha,
      );
    } else
      result = new ColorValue(
        key === "red" ? value : color.red,
        key === "green" ? value : color.green,
        key === "blue" ? value : color.blue,
        key === "alpha" ? value : color.alpha,
        () => {},
      );
    return modifiedColor(input, result);
  });
  engine.registerFilter("color_brightness", (value: unknown) => {
    const c = channels(value),
      n = (299 * c.red + 587 * c.green + 114 * c.blue) / 1000;
    const rounded = Math.round(n * 100) / 100;
    return new DecimalNumber(
      rounded,
      Number.isInteger(rounded) ? 1 : (rounded.toString().split(".")[1]?.length ?? 0),
    );
  });
  engine.registerFilter("color_contrast", (value: unknown, other: unknown) => {
    const a = luminance(channels(value)),
      b = luminance(channels(other));
    return new DecimalNumber(
      Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10,
      1,
    );
  });
  for (const [name, direction] of [
    ["color_lighten", 1],
    ["color_darken", -1],
  ] as const)
    engine.registerFilter(name, (value: unknown, amount: unknown) => {
      const c = channels(value),
        hsl = hslUnits(c);
      const result = fromHslUnits(
        hsl.h,
        hsl.s,
        Math.min(100, Math.max(0, hsl.l + direction * percent(amount))),
        c.alpha,
      );
      return modifiedColor(value, result);
    });
  engine.registerFilter("color_extract", (value: unknown, key: unknown) => {
    const c = channels(value),
      name = String(key);
    if (["red", "green", "blue", "alpha"].includes(name)) return Reflect.get(c, name);
    if (["hue", "saturation", "lightness"].includes(name)) return Reflect.get(c, name);
    throw new Error("Unsupported color component");
  });
  engine.registerFilter("color_to_hex", (value: unknown) => {
    const c = channels(value);
    return new ColorValue(c.red, c.green, c.blue, 1, () => {}).valueOf();
  });
  engine.registerFilter("color_to_rgb", (value: unknown) => {
    const c = channels(value);
    return c.alpha === 1
      ? `rgb(${c.red}, ${c.green}, ${c.blue})`
      : `rgba(${c.red}, ${c.green}, ${c.blue}, ${c.alpha})`;
  });
  for (const [name, label, direction] of [
    ["color_saturate", "Saturate", 1],
    ["color_desaturate", "Desaturate", -1],
  ] as const)
    engine.registerFilter(name, (value: unknown, amount: unknown) => {
      const input = parsedColor(value),
        change = direction * saturationAmount(amount, label);
      const { h, s, l } = input.hsl ?? hslUnits(input.color);
      const saturation = Math.min(100, Math.max(0, s + change));
      return input.format === "hsl"
        ? hslText(h, saturation, l, input.color.alpha)
        : colorText(fromHslUnits(h, saturation, l, input.color.alpha), input.format);
    });
  engine.registerFilter("color_mix", (value: unknown, other: unknown, percent: unknown) => {
    const first = parsedColor(value),
      second = parsedColor(other).color,
      weight = Number(toValue(percent)) / 100;
    if (!Number.isFinite(weight) || weight < 0 || weight > 1)
      throw new Error("Mix percentage must be a numeric value between 0 and 100");
    const mix = (a: number, b: number) => Math.round(a * weight + b * (1 - weight));
    const alpha =
      Math.round((first.color.alpha * weight + second.alpha * (1 - weight)) * 100) / 100;
    const color = new ColorValue(
      mix(first.color.red, second.red),
      mix(first.color.green, second.green),
      mix(first.color.blue, second.blue),
      alpha,
      () => {},
    );
    return colorText(color, first.format);
  });
  engine.registerFilter("color_to_hsl", (value: unknown) => {
    const input = parsedColor(value);
    const { h, s, l } = input.hsl ?? hslUnits(input.color);
    return hslText(h, s, l, input.color.alpha);
  });
  engine.registerFilter("color_to_oklch", (value: unknown) => oklch(parsedColor(value).color));
  engine.registerFilter("hex_to_rgba", (value: unknown, ...args: unknown[]) => {
    // An omitted alpha is 1; an explicit nil prints nothing, as on Shopify.
    const alpha = args.length === 0 ? 1 : (toValue(args[0]) ?? "");
    const text = String(toValue(value) ?? "");
    // Shopify leaves anything other than a 3- or 6-digit hex color unchanged.
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text.trim())) return text;
    const color = channels(text);
    return `rgba(${color.red},${color.green},${color.blue},${String(alpha)})`;
  });
  engine.registerFilter("brightness_difference", (value: unknown, other: unknown) =>
    Math.round(Math.abs(brightness(channels(value)) - brightness(channels(other)))),
  );
  engine.registerFilter("color_difference", (value: unknown, other: unknown) => {
    const a = channels(value),
      b = channels(other);
    return Math.abs(a.red - b.red) + Math.abs(a.green - b.green) + Math.abs(a.blue - b.blue);
  });
}
