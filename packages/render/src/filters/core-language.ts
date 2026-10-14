import { type Liquid, toValue } from "liquidjs";

function textValue(input: unknown): string {
  const value: unknown = toValue(input);
  return Array.isArray(value) ? value.map(textValue).join("") : String(value ?? "");
}

/** Public filter/operator overrides for reference-confirmed core language differences. */
export function registerCoreLanguage(engine: Liquid): void {
  const contains = engine.options.operators.contains;
  if (!contains) throw new Error("Pinned LiquidJS contains operator unavailable");
  engine.options.operators.contains = (left, right, context) => {
    const value: unknown = toValue(right);
    if (value === null || value === undefined) return false;
    return contains(left, right, context);
  };
  const replace = engine.filters.replace;
  if (typeof replace !== "function") throw new Error("Pinned LiquidJS replace filter unavailable");
  engine.registerFilter(
    "replace",
    function (input: unknown, search: unknown, replacement: unknown) {
      const pattern = textValue(search);
      if (pattern !== "") return replace.call(this, input, search, replacement);
      const text = textValue(input);
      const value = textValue(replacement);
      const characters = Array.from(text);
      this.context.memoryLimit.use(text.length + value.length * (characters.length + 1));
      const output = `${value}${characters.join(value)}${text ? value : ""}`;
      return output;
    },
  );
}
