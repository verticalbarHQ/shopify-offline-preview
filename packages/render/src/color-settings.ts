import { Drop } from "liquidjs";
import type { LiquidRecord } from "../../data/src/objects.js";

const internal = new Set([
  "then",
  "next",
  "toLiquid",
  "toJSON",
  "constructor",
  "__proto__",
  "prototype",
]);
export class ColorValue extends Drop {
  #unsupported: (message: string) => void;
  readonly color_space = "srgb";
  constructor(
    readonly red: number,
    readonly green: number,
    readonly blue: number,
    readonly alpha: number,
    unsupported: (message: string) => void,
  ) {
    super();
    this.#unsupported = unsupported;
  }
  get rgb() {
    return `${this.red} ${this.green} ${this.blue}`;
  }
  get rgba() {
    const a = Number.isInteger(this.alpha) ? this.alpha.toFixed(1) : String(this.alpha);
    return `${this.rgb} / ${a}`;
  }
  #hsl() {
    const [r = 0, g = 0, b = 0] = [this.red, this.green, this.blue].map((v) => v / 255);
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      delta = max - min,
      light = (max + min) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
    let hue = 0;
    if (delta !== 0)
      hue =
        max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return {
      hue: Math.round((hue * 60 + 360) % 360),
      saturation: Math.round(saturation * 100),
      lightness: Math.round(light * 100),
    };
  }
  get hue() {
    return this.#hsl().hue;
  }
  get saturation() {
    return this.#hsl().saturation;
  }
  get lightness() {
    return this.#hsl().lightness;
  }
  valueOf() {
    return (
      "#" +
      [this.red, this.green, this.blue, ...(this.alpha === 1 ? [] : [Math.round(this.alpha * 255)])]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    );
  }
  override liquidMethodMissing(key: string | number) {
    if (!internal.has(String(key))) this.#unsupported(`Color property ${key} is not implemented.`);
    return undefined;
  }
}
export function colorSetting(
  value: unknown,
  unsupported: (message: string) => void,
): ColorValue | null | string {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof ColorValue) return value;
  if (typeof value !== "string") {
    unsupported("Color setting input is not implemented.");
    return null;
  }
  const normalized = value.trim().toLowerCase();
  const named: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    transparent: "#00000000",
  };
  const text = named[normalized] ?? normalized;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex?.[1]) {
    const digits = hex[1].length < 5 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return new ColorValue(
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
      digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
      unsupported,
    );
  }
  const rgb =
    /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      text,
    );
  if (rgb) {
    const channels = rgb
      .slice(1, 4)
      .map((v) => Math.round(v.endsWith("%") ? (Number.parseFloat(v) * 255) / 100 : Number(v)));
    const alpha =
      rgb[4] === undefined
        ? 1
        : rgb[4].endsWith("%")
          ? Number.parseFloat(rgb[4]) / 100
          : Number(rgb[4]);
    if (
      channels.every((v) => Number.isFinite(v) && v >= 0 && v <= 255) &&
      Number.isFinite(alpha) &&
      alpha >= 0 &&
      alpha <= 1
    )
      return new ColorValue(
        channels[0] ?? 0,
        channels[1] ?? 0,
        channels[2] ?? 0,
        alpha,
        unsupported,
      );
  }
  unsupported("Color setting format is not implemented.");
  return value;
}
export class ColorScheme extends Drop {
  constructor(
    readonly id: string,
    readonly settings: LiquidRecord,
  ) {
    super();
  }
  valueOf() {
    return this.id;
  }
}
export class ColorSchemeGroup extends Drop {
  #schemes: ColorScheme[];
  constructor(schemes: ColorScheme[]) {
    super();
    this.#schemes = schemes;
  }
  get size() {
    return this.#schemes.length;
  }
  get first() {
    return this.#schemes[0] ?? null;
  }
  get last() {
    return this.#schemes.at(-1) ?? null;
  }
  valueOf() {
    return this.#schemes;
  }
  override liquidMethodMissing(key: string | number) {
    return this.#schemes.find((s) => s.id === String(key));
  }
}
