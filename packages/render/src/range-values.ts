import {
  type Comparable,
  type Context,
  Drop,
  evalTokenValue,
  type Liquid,
  type RangeToken,
  type Template,
  Token,
  TokenKind,
  TypeGuards,
  toPromise,
  toValue,
  Value,
} from "liquidjs";

/** Range identity survives storage and remains distinct from an array. */
export class LiquidRange extends Drop implements Comparable, Iterable<number> {
  readonly #start: number;
  readonly #end: number;
  constructor(start: number, end: number) {
    super();
    this.#start = start;
    this.#end = end;
  }
  get length() {
    return Math.max(0, this.#end - this.#start + 1);
  }
  size() {
    return this.length;
  }
  first() {
    return this.#start;
  }
  last() {
    return this.#end;
  }
  valueOf() {
    return this;
  }
  toString() {
    return `${this.#start}..${this.#end}`;
  }
  *[Symbol.iterator]() {
    for (let value = this.#start; value <= this.#end; value++) yield value;
  }
  toJSON() {
    return Array.from(this);
  }
  equals() {
    return false;
  }
  indexOf(input: unknown) {
    const raw: unknown = toValue(input);
    const value = raw instanceof Number ? Number(raw) : raw;
    return typeof value === "number" && value >= this.#start && value <= this.#end
      ? value - this.#start
      : -1;
  }
  gt() {
    return false;
  }
  geq() {
    return false;
  }
  lt() {
    return false;
  }
  leq() {
    return false;
  }
}
/** An SDK-owned RangeToken carries a prepared Drop through the public evalToken value path. */
export class PreparedRangeToken extends Token implements RangeToken {
  lhs: RangeToken["lhs"];
  rhs: RangeToken["rhs"];
  content: LiquidRange | undefined;
  constructor(token: RangeToken) {
    super(TokenKind.Range, token.input, token.begin, token.end, token.file);
    this.lhs = token.lhs;
    this.rhs = token.rhs;
  }
  async prepare(context: Context): Promise<void> {
    await prepareRangeToken(this.lhs, context);
    await prepareRangeToken(this.rhs, context);
    const low: unknown = await toPromise(evalTokenValue(this.lhs, context));
    const high: unknown = await toPromise(evalTokenValue(this.rhs, context));
    const dynamic =
      TypeGuards.isPropertyAccessToken(this.lhs) ||
      TypeGuards.isPropertyAccessToken(this.rhs) ||
      TypeGuards.isFilteredValueToken(this.lhs) ||
      TypeGuards.isFilteredValueToken(this.rhs);
    const start = integer(low, dynamic),
      end = integer(high, dynamic);
    const length = Math.max(0, end - start + 1);
    if (!Number.isSafeInteger(length)) throw new Error("Range size exceeds preview limits");
    context.memoryLimit.use(length);
    this.content = new LiquidRange(start, end);
  }
}
function integer(input: unknown, dynamic: boolean): number {
  const value: unknown = toValue(input);
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") {
    const number = Number.parseInt(value, 10) || 0;
    if (!Number.isSafeInteger(number)) throw new Error("invalid integer");
    return number;
  }
  if (typeof value === "number" || value instanceof Number) {
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isSafeInteger(Math.trunc(number)))
      throw new Error("invalid integer");
    if (dynamic && (value instanceof Number || !Number.isInteger(number)))
      throw new Error("invalid integer");
    return Math.trunc(number);
  }
  throw new Error("invalid integer");
}
export async function prepareRangeToken(token: Token, context: Context): Promise<void> {
  if (token instanceof PreparedRangeToken) {
    await token.prepare(context);
    return;
  }
  if (TypeGuards.isPropertyAccessToken(token)) {
    if (token.variable) await prepareRangeToken(token.variable, context);
    for (const prop of token.props) await prepareRangeToken(prop, context);
  }
  if (TypeGuards.isFilteredValueToken(token)) {
    for (const part of token.initial.postfix) await prepareRangeToken(part, context);
    for (const filter of token.filters)
      for (const arg of filter.args) {
        const value = Array.isArray(arg) ? arg[1] : arg;
        if (value) await prepareRangeToken(value, context);
      }
  }
}
export async function prepareRangeValue(value: Value, context: Context): Promise<void> {
  for (const token of value.initial.postfix) await prepareRangeToken(token, context);
  for (const filter of value.filters)
    for (const arg of filter.args) {
      const token = Array.isArray(arg) ? arg[1] : arg;
      if (token) await prepareRangeToken(token, context);
    }
}
export async function prepareRangeArguments(template: Template, context: Context): Promise<void> {
  for (const arg of template.arguments?.() ?? []) {
    if (arg instanceof Value) await prepareRangeValue(arg, context);
    else await prepareRangeToken(arg, context);
  }
}
export function registerRangeFilters(engine: Liquid): void {
  for (const name of ["==", "!=", ">", ">=", "<", "<="] as const) {
    const original = engine.options.operators[name];
    if (!original) throw new Error(`Pinned LiquidJS ${name} operator unavailable`);
    engine.options.operators[name] = (left, right, context) =>
      left instanceof LiquidRange || right instanceof LiquidRange
        ? name === "!="
        : original(left, right, context);
  }
  for (const name of [
    "join",
    "map",
    "where",
    "find",
    "find_index",
    "reject",
    "has",
    "compact",
    "concat",
    "reverse",
    "sort",
    "sort_natural",
    "uniq",
    "sum",
  ]) {
    const original = engine.filters[name];
    if (!original) continue;
    const handler = typeof original === "function" ? original : original.handler;
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      const convert = (value: unknown) =>
        value instanceof LiquidRange ? Array.from(value) : value;
      if (name === "concat" && args[0] instanceof LiquidRange)
        throw new Error("concat filter requires an array argument");
      return handler.call(this, convert(input), ...args);
    });
  }
  for (const name of ["first", "last", "size"] as const) {
    const original = engine.filters[name];
    if (!original) continue;
    const handler = typeof original === "function" ? original : original.handler;
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      return input instanceof LiquidRange ? input[name]() : handler.call(this, input, ...args);
    });
  }
}
