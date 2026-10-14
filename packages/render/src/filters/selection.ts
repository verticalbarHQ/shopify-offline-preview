import { type Context, Drop, isTruthy, type Liquid, toPromise, toValue } from "liquidjs";
import { LiquidRange } from "../range-values.js";

const noLookup = Symbol("selection item does not support property lookup");
function numeric(input: unknown): number | undefined {
  const value: unknown = toValue(input);
  return typeof value === "number" ? value : value instanceof Number ? Number(value) : undefined;
}
function propertyError(key: unknown): never {
  throw new Error(`cannot select the property '${String(key ?? "")}'`);
}
function stringProperty(value: string, key: unknown, context: Context): unknown {
  if (typeof key === "string") return value.includes(key) ? key : undefined;
  context.memoryLimit.use(value.length);
  const characters = Array.from(value);
  const number = numeric(key);
  if (number !== undefined && Number.isFinite(number)) {
    const index = Math.trunc(number);
    return characters[index < 0 ? characters.length + index : index];
  }
  if (key instanceof LiquidRange) {
    const start = key.first() < 0 ? characters.length + key.first() : key.first();
    const end = key.last() < 0 ? characters.length + key.last() : key.last();
    return start < 0 || start > characters.length
      ? undefined
      : characters.slice(start, Math.max(start, end + 1)).join("");
  }
  return propertyError(key);
}
function integerProperty(value: number, key: unknown, context: Context): unknown {
  if (!Number.isInteger(value)) return noLookup;
  if (!Number.isSafeInteger(value)) throw new Error("Selection value exceeds numeric precision");
  const number = numeric(key);
  if (number !== undefined && Number.isFinite(number)) {
    const index = Math.trunc(number);
    return index < 0 ? 0 : Number((BigInt(value) >> BigInt(index)) & 1n);
  }
  if (key instanceof LiquidRange) {
    const start = key.first(),
      length = key.length;
    context.memoryLimit.use(length);
    if (!length) return 0;
    if (start < 0 && length + start <= 0) return 0;
    const mask = (1n << BigInt(length)) - 1n;
    const shifted = start < 0 ? BigInt(value) << BigInt(-start) : BigInt(value) >> BigInt(start);
    const result = Number(shifted & mask);
    if (!Number.isSafeInteger(result)) throw new Error("Selection value exceeds numeric precision");
    return result;
  }
  return propertyError(key);
}
function property(item: unknown, key: unknown, context: Context): unknown {
  if (item instanceof Drop) {
    if (typeof key !== "string" && typeof key !== "number" && !(key instanceof Drop))
      return undefined;
    return context.readProperty(item, key);
  }
  if (typeof item === "string") return stringProperty(item, key, context);
  if (typeof item === "number") return integerProperty(item, key, context);
  if (item !== null && typeof item === "object" && !(item instanceof Number)) {
    if (typeof key !== "string") return undefined;
    return context.readProperty(item, key);
  }
  return noLookup;
}
function* flatten(input: unknown[]): Generator<unknown> {
  for (const item of input) {
    if (Array.isArray(item)) yield* flatten(item);
    else yield item;
  }
}
/** Selection reads item properties literally; it never searches a caller's global scope. */
export function registerSelectionFilters(engine: Liquid): void {
  for (const name of ["where", "reject", "find", "find_index", "has"] as const) {
    engine.registerFilter(name, async function (input: unknown, key: unknown, expected?: unknown) {
      const value: unknown = toValue(input);
      const items: unknown[] = [];
      const source = Array.isArray(value)
        ? flatten(value)
        : value === null || value === undefined
          ? []
          : [value];
      for (const item of source) {
        this.context.memoryLimit.use(1);
        items.push(item);
      }
      const field: unknown = toValue(key);
      const target: unknown = toValue(expected);
      const equal = this.context.opts.operators["=="];
      if (!equal) throw new Error("Pinned LiquidJS equality operator unavailable");
      const selected: unknown[] = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const candidate: unknown = await toPromise(property(item, field, this.context));
        if (candidate === noLookup) return null;
        const matched =
          target === null || target === undefined
            ? isTruthy(toValue(candidate), this.context)
            : await toPromise(equal(candidate, expected, this.context));
        if (name === "reject" ? !matched : matched) {
          if (name === "has") return true;
          if (name === "find_index") return index;
          if (name === "find") return item;
          selected.push(item);
        }
      }
      return name === "has" ? false : name === "find" || name === "find_index" ? null : selected;
    });
  }
}
