import { type Comparable, toValue } from "liquidjs";

/** Float identity survives assign/filter chains even when its numeric value is integral. */
export class LiquidFloat extends Number implements Comparable {
  [Symbol.toPrimitive](hint: string) {
    const value = this.valueOf();
    if (hint !== "string") return value;
    if (Object.is(value, -0)) return "-0.0";
    const text = String(value);
    return Number.isFinite(value) && Number.isInteger(value) && !text.includes("e")
      ? `${text}.0`
      : text;
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
