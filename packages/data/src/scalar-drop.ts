import { Drop } from "liquidjs";

/** A Liquid object that outputs and compares as a scalar, like Shopify's `template` drop. */
export class ScalarDrop extends Drop {
  readonly #scalar: unknown;
  readonly #missing: ((property: string) => void) | undefined;
  constructor(
    fields: Record<string, unknown>,
    scalar: unknown,
    missing?: (property: string) => void,
  ) {
    super();
    Object.defineProperties(this, Object.getOwnPropertyDescriptors(fields));
    this.#scalar = scalar;
    this.#missing = missing;
  }
  valueOf() {
    return this.#scalar;
  }
  override liquidMethodMissing(property: string | number) {
    this.#missing?.(String(property));
    return undefined;
  }
}

/** Snapshot focal points are exact decimal fractions; Liquid exposes percentages. */
export function focalPointPercent(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const amount = (BigInt(whole) * scale + BigInt(fraction || "0")) * 100n;
  const decimals = (amount % scale).toString().padStart(fraction.length, "0").replace(/0+$/, "");
  return `${amount / scale}${decimals ? `.${decimals}` : ""}%`;
}

/** `focal_point` prints as `x% y%` and exposes numeric `x`/`y` percentages. */
export function focalPoint(
  point: { x: string; y: string },
  missing?: (property: string) => void,
): ScalarDrop {
  const x = focalPointPercent(point.x),
    y = focalPointPercent(point.y);
  return new ScalarDrop(
    { x: Number(x.slice(0, -1)), y: Number(y.slice(0, -1)) },
    `${x} ${y}`,
    missing,
  );
}
