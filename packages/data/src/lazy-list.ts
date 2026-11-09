/** A thenable whose I/O starts only when Liquid actually awaits the referenced value. */
export class Deferred<T> implements PromiseLike<T> {
  private promise: Promise<T> | undefined;
  constructor(private readonly read: () => Promise<T>) {}
  // biome-ignore lint/suspicious/noThenProperty: PromiseLike is the intentional lazy I/O boundary.
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.promise ??= this.read();
    return this.promise.then(onfulfilled, onrejected);
  }
}
interface LazyListState<T> {
  read(start: number, length: number, direction: 1 | -1): Promise<T[]>;
  start: number;
  length: number;
  direction: 1 | -1;
  missing?: (start: number, length: number, direction: 1 | -1) => Promise<boolean>;
}
const lists = new WeakMap<unknown[], LazyListState<unknown>>();
export function isLazyList(value: unknown): value is unknown[] {
  return Array.isArray(value) && lists.has(value);
}
/** Native Liquid for/paginate use Array#slice; views keep offset + limit O(visited), not O(total). */
export function lazyList<T>(
  length: number,
  read: LazyListState<T>["read"],
  start = 0,
  direction: 1 | -1 = 1,
  missing?: LazyListState<T>["missing"],
): (T | Deferred<T>)[] {
  const target: (T | Deferred<T>)[] = new Array(length);
  const references = new Map<number, Deferred<T>>();
  const at = (index: number) => {
    if (index < 0 || index >= length) return undefined;
    let value = references.get(index);
    if (!value) {
      value = new Deferred(async () => {
        const values = await read(start + index * direction, 1, direction);
        return values[0] as T;
      });
      references.set(index, value);
    }
    return value;
  };
  const bound = (value: number | undefined, fallback: number) =>
    value === undefined
      ? fallback
      : Number.isNaN(value)
        ? 0
        : value < 0
          ? Math.max(0, length + Math.trunc(value))
          : Math.min(length, Math.trunc(value));
  const proxy = new Proxy(target, {
    get(array, key, receiver) {
      if (key === "slice")
        return (from?: number, to?: number) => {
          const first = bound(from, 0);
          const last = bound(to, length);
          return lazyList(
            Math.max(0, last - first),
            read,
            start + first * direction,
            direction,
            missing,
          );
        };
      if (key === "reverse")
        return () =>
          lazyList(
            length,
            read,
            start + (length - 1) * direction,
            direction === 1 ? -1 : 1,
            missing,
          );
      if (key === "at") return (index: number) => at(index < 0 ? length + index : index);
      if (key === Symbol.iterator)
        return function* () {
          // The final bounded for-loop view is known here. Read at most 100 bodies per batch.
          for (let offset = 0; offset < length; offset += 100) {
            const count = Math.min(100, length - offset);
            let batch: Promise<T[]> | undefined;
            for (let index = 0; index < count; index++)
              yield new Deferred(async () => {
                batch ??= read(start + offset * direction, count, direction);
                return (await batch)[index] as T;
              });
          }
        };
      if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) return at(Number(key));
      return Reflect.get(array, key, receiver);
    },
    has(array, key) {
      return typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)
        ? Number(key) < length
        : Reflect.has(array, key);
    },
    getOwnPropertyDescriptor(array, key) {
      return typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length
        ? { configurable: true, enumerable: true, value: at(Number(key)), writable: false }
        : Reflect.getOwnPropertyDescriptor(array, key);
    },
  });
  lists.set(proxy, { read, start, length, direction, ...(missing ? { missing } : {}) });
  return proxy;
}
/** Materialize only the already bounded view, for filters which genuinely inspect its members. */
export async function materializeList(value: unknown[]): Promise<unknown[]> {
  const state = lists.get(value);
  if (!state) return Promise.all(value);
  const result: unknown[] = [];
  for (let index = 0; index < state.length; index += 100)
    result.push(
      ...(await state.read(
        state.start + index * state.direction,
        Math.min(100, state.length - index),
        state.direction,
      )),
    );
  return result;
}

export async function containsMissing(value: unknown[]): Promise<boolean> {
  const state = lists.get(value);
  return state?.missing
    ? state.missing(state.start, state.length, state.direction)
    : (await materializeList(value)).includes(null);
}

/** Concatenation joins identities; it does not inspect or deserialize either domain. */
export function concatLists(left: unknown[], right: unknown[]): unknown[] {
  const length = left.length + right.length;
  const parts = (start: number, count: number, direction: 1 | -1) => {
    const offset = direction === 1 ? start : start - count + 1,
      end = offset + count;
    const values: unknown[][] = [];
    if (offset < left.length) values.push(left.slice(offset, Math.min(left.length, end)));
    if (end > left.length)
      values.push(right.slice(Math.max(0, offset - left.length), end - left.length));
    return values;
  };
  return lazyList(
    length,
    async (start, count, direction) => {
      const result = (
        await Promise.all(parts(start, count, direction).map(materializeList))
      ).flat();
      return direction === 1 ? result : result.reverse();
    },
    0,
    1,
    async (start, count, direction) =>
      (await Promise.all(parts(start, count, direction).map(containsMissing))).some(Boolean),
  );
}
