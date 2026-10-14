import {
  type Comparable,
  Context,
  type Liquid,
  type Template,
  type Token,
  TypeGuards,
  toPromise,
  toValue,
  Value,
} from "liquidjs";

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
function decorateToken(token: Token): void {
  if (
    TypeGuards.isNumberToken(token) &&
    token.getText().includes(".") &&
    typeof token.content === "number"
  ) {
    // NumberToken.content is a public AST value, evaluated unchanged by the pinned
    // engine. Its primitive-only annotation omits Comparable Number subclasses.
    // Keep this type adaptation here; no private parser/filter fields are touched.
    token.content = new LiquidFloat(token.content) as unknown as number;
  }
  if (TypeGuards.isRangeToken(token)) {
    decorateToken(token.lhs);
    decorateToken(token.rhs);
  }
  if (TypeGuards.isPropertyAccessToken(token)) {
    if (token.variable) decorateToken(token.variable);
    for (const property of token.props) decorateToken(property);
  }
  if (TypeGuards.isFilteredValueToken(token)) {
    for (const value of token.initial.postfix) decorateToken(value);
    for (const filter of token.filters)
      for (const argument of filter.args) {
        if (Array.isArray(argument)) {
          if (argument[1]) decorateToken(argument[1]);
        } else decorateToken(argument);
      }
  }
}
export function decorateNumericValue(value: Value): void {
  for (const token of value.initial.postfix) decorateToken(token);
  for (const filter of value.filters)
    for (const argument of filter.args) {
      if (Array.isArray(argument)) {
        if (argument[1]) decorateToken(argument[1]);
      } else decorateToken(argument);
    }
}
export function preserveNumericLiterals(templates: Template[]): void {
  for (const template of templates) {
    for (const argument of template.arguments?.() ?? []) {
      if (argument instanceof Value) decorateNumericValue(argument);
      else decorateToken(argument);
    }
    const iterator = template.children?.(false, true);
    if (!iterator) continue;
    let result = iterator.next();
    while (!result.done) {
      if (Array.isArray(result.value)) preserveNumericLiterals(result.value);
      result = iterator.next();
    }
    if (Array.isArray(result.value)) preserveNumericLiterals(result.value);
  }
}
function numeric(input: unknown): { value: number; float: boolean } {
  const value: unknown = toValue(input);
  if (typeof value === "number" || value instanceof Number)
    return { value: Number(value), float: value instanceof Number || !Number.isInteger(value) };
  if (typeof value === "string") {
    const float = /^[+-]?\d+\.\d+$/.test(value.trim());
    const number = float ? Number(value) : Number.parseInt(value, 10);
    return { value: Number.isNaN(number) ? 0 : number, float };
  }
  return { value: 0, float: false };
}
export function registerNumericFilters(engine: Liquid): void {
  for (const name of ["plus", "minus", "times", "divided_by", "modulo"] as const)
    engine.registerFilter(name, (input: unknown, argument: unknown) => {
      const left = numeric(input),
        right = numeric(argument),
        float = left.float || right.float;
      if (right.value === 0 && (name === "modulo" || (name === "divided_by" && !float)))
        throw new Error("divided by 0");
      const result =
        float && Number.isFinite(left.value) && Number.isFinite(right.value) && right.value !== 0
          ? decimalOperation(left.value, right.value, name)
          : name === "plus"
            ? left.value + right.value
            : name === "minus"
              ? left.value - right.value
              : name === "times"
                ? left.value * right.value
                : name === "divided_by"
                  ? float
                    ? left.value / right.value
                    : Math.floor(left.value / right.value)
                  : remainder(left.value, right.value);
      return float ? new LiquidFloat(result) : result;
    });
  engine.registerFilter("abs", (input: unknown) => {
    const value = numeric(input);
    return value.float ? new LiquidFloat(Math.abs(value.value)) : Math.abs(value.value);
  });
}
function remainder(left: number, right: number): number {
  const value = left % right;
  return value !== 0 && value < 0 !== right < 0 ? value + right : value;
}

/** Liquid's arithmetic converts floats to decimal values before applying the operation. */
function decimal(value: number): { coefficient: bigint; scale: number } {
  const [mantissa = "0", exponent = "0"] = String(value).split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return { coefficient: BigInt(mantissa.replace(".", "")), scale: fraction - Number(exponent) };
}
function decimalOperation(
  left: number,
  right: number,
  operation: "plus" | "minus" | "times" | "divided_by" | "modulo",
): number {
  const a = decimal(left),
    b = decimal(right);
  if (operation === "times")
    return Number(`${a.coefficient * b.coefficient}e${-a.scale - b.scale}`);
  if (operation === "divided_by") {
    // Forty significant decimal digits exceed the precision of a returned JS float.
    // Adjust for coefficient magnitude so tiny/huge finite operands stay bounded.
    const digits = Math.max(0, 40 + String(b.coefficient).length - String(a.coefficient).length);
    const coefficient = (a.coefficient * 10n ** BigInt(digits)) / b.coefficient;
    return Number(`${coefficient}e${b.scale - a.scale - digits}`);
  }
  const scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale);
  const y = b.coefficient * 10n ** BigInt(scale - b.scale);
  let coefficient = operation === "plus" ? x + y : operation === "minus" ? x - y : x % y;
  if (operation === "modulo" && coefficient !== 0n && coefficient < 0n !== y < 0n) coefficient += y;
  return Number(`${coefficient}e${-scale}`);
}

export async function evalNumericValue(
  engine: Liquid,
  input: string,
  context?: Context,
): Promise<unknown> {
  const value = new Value(input, engine);
  decorateNumericValue(value);
  return toPromise(value.value(context ?? new Context({}, engine.options, {}, { liquid: engine })));
}
