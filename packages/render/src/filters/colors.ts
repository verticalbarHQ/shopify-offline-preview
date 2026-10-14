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
function fromHsl(h: number, s: number, l: number, alpha: number): ColorValue {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return new ColorValue(channel(0), channel(8), channel(4), alpha, () => {});
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
      const hsl = exactHsl(color);
      result = fromHsl(
        key === "hue" ? value / 360 : hsl.h,
        key === "saturation" ? value / 100 : hsl.s,
        key === "lightness" ? value / 100 : hsl.l,
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
        hsl = exactHsl(c);
      const result = fromHsl(
        hsl.h,
        hsl.s,
        Math.min(1, Math.max(0, hsl.l + (direction * percent(amount)) / 100)),
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
}
