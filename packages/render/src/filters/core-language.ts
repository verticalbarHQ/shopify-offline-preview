import { type Liquid, Tokenizer, toValue } from "liquidjs";
import { liquidObjectKind } from "../../../data/src/objects.js";
import { isSnapshotHash } from "../json-hashes.js";
import { LiquidRange } from "../range-values.js";

function textValue(input: unknown): string {
  const value: unknown = toValue(input);
  return Array.isArray(value) ? value.map(textValue).join("") : String(value ?? "");
}

function integer(input: unknown): bigint {
  const value: unknown = toValue(input);
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value))
    return BigInt(value);
  const text = String(value ?? "").replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
  const match = /^([+-]?)(.*)$/.exec(text);
  const sign = match?.[1] === "-" ? -1n : 1n;
  let digits = match?.[2] ?? "",
    base = 10;
  if (/^0[xX]/.test(digits)) {
    base = 16;
    digits = digits.slice(2);
  } else if (/^0[bB]/.test(digits)) {
    base = 2;
    digits = digits.slice(2);
  } else if (/^0[oO]/.test(digits)) {
    base = 8;
    digits = digits.slice(2);
  } else if (/^0[dD]/.test(digits)) digits = digits.slice(2);
  else if (digits.length > 1 && digits[0] === "0") base = 8;
  const pattern =
    base === 16
      ? /^[\da-f](?:_?[\da-f])*$/i
      : base === 8
        ? /^[0-7](?:_?[0-7])*$/
        : base === 2
          ? /^[01](?:_?[01])*$/
          : /^\d(?:_?\d)*$/;
  if (!pattern.test(digits)) throw new Error("invalid integer");
  const prefix = base === 16 ? "0x" : base === 8 ? "0o" : base === 2 ? "0b" : "";
  return sign * BigInt(prefix + digits.replaceAll("_", ""));
}

function quoted(text: string): string {
  const escapes: Record<string, string> = {
    '"': '\\"',
    "\\": "\\\\",
    "\u0007": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    "\u001b": "\\e",
  };
  const characters = Array.from(text);
  return (
    '"' +
    characters
      .map((char, index) => {
        if (escapes[char]) return escapes[char];
        if (char === "#" && /[{@$]/.test(characters[index + 1] ?? "")) return "\\#";
        const code = char.charCodeAt(0);
        if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
          return `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
        return char;
      })
      .join("") +
    '"'
  );
}
/** Filter coercion inspects arrays/hashes; direct Liquid output concatenates arrays instead. */
function inspect(input: unknown, seen = new WeakSet<object>()): string {
  const value: unknown = toValue(input);
  if (value === null || value === undefined) return "nil";
  if (value instanceof LiquidRange) return String(value);
  if (typeof value === "string") return quoted(value);
  if (typeof value !== "object" || value instanceof Number) return String(value);
  const array = Array.isArray(value);
  if (seen.has(value)) return array ? "[...]" : "{...}";
  seen.add(value);
  try {
    return array
      ? `[${value.map((item) => inspect(item, seen)).join(", ")}]`
      : `{${Object.entries(value)
          .map(([key, item]) => `${quoted(key)}=>${inspect(item, seen)}`)
          .join(", ")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Ruby-style string coercion for filters that accept arrays or ordinary hashes. */
export function liquidFilterText(input: unknown): string {
  const value: unknown = toValue(input);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return inspect(value);
  if (typeof value === "object" && !(value instanceof Number) && !(value instanceof LiquidRange)) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      (prototype === Object.prototype || prototype === null) &&
      !(Object.hasOwn(value, "toString") && typeof Reflect.get(value, "toString") === "function")
    )
      return inspect(value);
  }
  return String(value);
}

/** Direct output concatenates arrays, but ordinary JSON hashes use Liquid's Ruby notation. */
export function liquidOutputValue(input: unknown): unknown {
  const value: unknown = toValue(input);
  if (Array.isArray(value)) return value.map(liquidOutputValue);
  if (value !== null && typeof value === "object" && isSnapshotHash(value)) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return inspect(value);
  }
  return value;
}

/** Public filter/operator overrides for reference-confirmed core language differences. */
export function registerCoreLanguage(engine: Liquid): void {
  const blank = new Tokenizer("blank").readLiteral()?.content;
  const empty = new Tokenizer("empty").readLiteral()?.content;
  const nil = new Tokenizer("nil").readLiteral()?.content;
  if (blank === undefined || empty === undefined || nil === undefined)
    throw new Error("Pinned LiquidJS literal values unavailable");
  for (const name of ["==", "!="] as const) {
    const original = engine.options.operators[name];
    if (!original) throw new Error("Pinned LiquidJS equality operator unavailable");
    engine.options.operators[name] = (left, right, context) => {
      let result: boolean | undefined;
      const cart = left === empty ? right : right === empty ? left : undefined;
      if (liquidObjectKind(cart) === "cart")
        result = Reflect.get(cart as object, "item_count") === 0;
      else if ((left === blank && right === empty) || (left === empty && right === blank))
        result = false;
      else if ((left === blank && right === nil) || (left === nil && right === blank))
        result = true;
      return result === undefined
        ? original(left, right, context)
        : name === "=="
          ? result
          : !result;
    };
  }
  engine.registerFilter("truncatewords", function (input: unknown, ...options: unknown[]) {
    const value: unknown = toValue(input);
    if (value === null || value === undefined) return null;
    const text =
      typeof value === "object" && !(value instanceof Number) ? inspect(value) : String(value);
    const suffixValue: unknown = toValue(options.length < 2 ? "..." : options[1]);
    const suffix =
      typeof suffixValue === "object" && suffixValue !== null && !(suffixValue instanceof Number)
        ? inspect(suffixValue)
        : String(suffixValue ?? "");
    this.context.memoryLimit.use(text.length + suffix.length);
    const parsed = integer(options.length < 1 ? 15 : options[0]);
    const limit = parsed <= 0n ? 1n : parsed;
    const trimmed = text.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
    const words = trimmed ? trimmed.split(/[ \t\r\n\f\v]+/) : [];
    if (BigInt(words.length) <= limit) return text;
    return words.slice(0, Number(limit)).join(" ") + suffix;
  });
  const contains = engine.options.operators.contains;
  if (!contains) throw new Error("Pinned LiquidJS contains operator unavailable");
  engine.options.operators.contains = (left, right, context) => {
    const value: unknown = toValue(right);
    if (value === null || value === undefined || value === false) return false;
    return contains(left, right, context);
  };
  // Shopify's standard string filters read an array input or argument in Ruby notation, so
  // `["a", "b"] | append: "!"` is `["a", "b"]!` rather than `ab!`.
  // Shopify prints a store object in a list by its class name, which the preview does not model,
  // so only lists of plain values are written this way.
  const plain = (value: unknown): boolean => {
    const item: unknown = toValue(value);
    if (item === null || typeof item !== "object" || item instanceof Number) return true;
    if (Array.isArray(item)) return item.every(plain);
    return isSnapshotHash(item) && Object.values(item).every(plain);
  };
  const plainList = (value: unknown) => Array.isArray(toValue(value)) && plain(value);
  const arrayText = (value: unknown) => (plainList(value) ? inspect(value) : value);
  for (const name of [
    "append",
    "prepend",
    "capitalize",
    "downcase",
    "upcase",
    "lstrip",
    "rstrip",
    "strip",
    "strip_html",
    "strip_newlines",
    "newline_to_br",
    "remove",
    "remove_first",
    "remove_last",
    "replace_first",
    "replace_last",
    "split",
    "truncate",
    "url_encode",
    "url_decode",
  ]) {
    const original = engine.filters[name];
    if (typeof original !== "function")
      throw new Error(`Pinned LiquidJS ${name} filter unavailable`);
    engine.registerFilter(name, function (input: unknown, ...args: unknown[]) {
      return original.call(this, arrayText(input), ...args.map(arrayText));
    });
  }
  // Ruby's CGI.escapeHTML: a double quote becomes &quot; (LiquidJS writes &#34;). escape_once
  // leaves any named or decimal entity alone, as Shopify does.
  const htmlEscapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  // escape leaves nil as nil; escape_once turns it into an empty string.
  const htmlEscape = (pattern: RegExp, nil: "" | null) =>
    function (this: { context: { memoryLimit: { use(size: number): void } } }, input: unknown) {
      const value: unknown = toValue(input);
      if (value === null || value === undefined) return nil;
      const text = plainList(value) ? inspect(value) : textValue(value);
      this.context.memoryLimit.use(text.length);
      return text.replace(pattern, (match) => htmlEscapes[match] ?? match);
    };
  engine.registerFilter("escape", htmlEscape(/[&<>"']/g, null));
  engine.registerFilter("escape_once", htmlEscape(/["><']|&(?![a-zA-Z]+;|#\d+;)/g, ""));
  const replace = engine.filters.replace;
  if (typeof replace !== "function") throw new Error("Pinned LiquidJS replace filter unavailable");
  engine.registerFilter("replace", function (...args: unknown[]) {
    const [input, search, replacement] = args.map(arrayText);
    const pattern = textValue(search);
    if (pattern !== "") return replace.call(this, input, search, replacement);
    const text = textValue(input);
    const value = textValue(replacement);
    const characters = Array.from(text);
    this.context.memoryLimit.use(text.length + value.length * (characters.length + 1));
    const output = `${value}${characters.join(value)}${text ? value : ""}`;
    return output;
  });
}
