import { type Liquid, toPromise, toValue } from "liquidjs";
import { concatLists, isLazyList, materializeList } from "../../data/src/lazy-list.js";
import { isCollectionProductList, markCollectionProductList } from "../../data/src/objects.js";
import { SourceDictionary } from "../../data/src/source-objects.js";

/** Native filters are synchronous in some positions; hydrate only domains they inspect. */
export function registerAsyncValues(engine: Liquid): void {
  const bounded = new Set(["size", "default", "first", "last", "slice", "reverse", "concat"]);
  for (const [name, native] of Object.entries(engine.filters)) {
    if (typeof native !== "function") continue;
    engine.registerFilter(name, async function (input: unknown, ...args: unknown[]) {
      input = await input;
      if (input instanceof SourceDictionary && !bounded.has(name)) input = await input.enumerate();
      if (isLazyList(input) && !bounded.has(name)) {
        const values = await materializeList(input);
        input = isCollectionProductList(input) ? markCollectionProductList(values) : values;
      }
      const result: unknown = await toPromise(native.call(this, input, ...args));
      return await result;
    });
  }
}

/** Preserve native filter bounds while avoiding native Array.prototype.slice's eager references. */
export function registerLazyArrayFilters(engine: Liquid): void {
  for (const name of ["slice", "reverse", "concat"] as const) {
    const native = engine.filters[name];
    if (typeof native !== "function") throw new Error(`Pinned LiquidJS ${name} filter unavailable`);
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      if (name === "concat" && (isLazyList(input) || isLazyList(args[0]))) {
        const array = (value: unknown): unknown[] => {
          const item = toValue(value);
          return item === null || item === undefined ? [] : Array.isArray(item) ? item : [item];
        };
        const left = array(input),
          right = array(args[0]);
        this.context.memoryLimit.use(left.length + right.length);
        return concatLists(left, right);
      }
      if (!isLazyList(input)) return native.call(this, input, ...args);
      if (name === "reverse") return input.reverse();
      const begin = Number(toValue(args[0] ?? 0)),
        length = Number(toValue(args[1] ?? 1));
      const start = begin < 0 ? input.length + begin : begin;
      if (start < 0 || length < 0) return [];
      this.context.memoryLimit.use(length);
      return input.slice(start, start + length);
    });
  }
}
