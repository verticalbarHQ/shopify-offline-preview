import { type Comparable, type Liquid, toValue } from "liquidjs";
import { ColorValue, colorSetting } from "../color-settings.js";

/** Preserves the float's display while arithmetic and comparisons still use a number. */
class DecimalNumber extends Number implements Comparable {
  constructor(
    value: number,
    readonly digits: number,
  ) {
    super(value);
  }
  [Symbol.toPrimitive](hint: string) {
    return hint === "string" ? this.valueOf().toFixed(this.digits) : this.valueOf();
  }
  equals(other: unknown) {
    const value: unknown = toValue(other);
    return (
      (typeof value === "number" || value instanceof Number) && this.valueOf() === Number(value)
    );
  }
  gt(other: unknown) {
    return this.valueOf() > Number(toValue(other));
  }
  geq(other: unknown) {
    return this.valueOf() >= Number(toValue(other));
  }
  lt(other: unknown) {
    return this.valueOf() < Number(toValue(other));
  }
  leq(other: unknown) {
    return this.valueOf() <= Number(toValue(other));
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
export function registerColorFilters(engine: Liquid): void {
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
      return result.alpha === 1
        ? result.valueOf()
        : `rgba(${result.red}, ${result.green}, ${result.blue}, ${result.alpha})`;
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
