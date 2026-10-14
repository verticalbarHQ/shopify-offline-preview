import {
  type LiquidArgument,
  type LiquidConditionalExpression,
  type LiquidExpression,
  NodeTypes,
} from "@shopify/liquid-html-parser";

export type Symbols = Map<string, Set<string>>;
export interface TypeHooks {
  lookup(expression: LiquidExpression, symbols: Symbols): Set<string>;
  root(name: string): Set<string>;
  property(type: string, name: string): string[] | undefined;
}
export function lookupKey(expression: LiquidExpression, length?: number): string | undefined {
  if (expression.type !== NodeTypes.VariableLookup || !expression.name) return undefined;
  const parts = expression.lookups.slice(0, length ?? expression.lookups.length);
  if (!parts.length) return expression.name;
  if (parts.some((part) => part.type !== NodeTypes.String)) return undefined;
  return `\0${JSON.stringify(expression.name)}:${JSON.stringify(parts.map((part) => (part.type === NodeTypes.String ? part.value : "")))}`;
}
export function bind(symbols: Symbols, name: string, types: Set<string>): Symbols {
  const prefix = `\0${JSON.stringify(name)}:`;
  return new Map([...symbols].filter(([key]) => !key.startsWith(prefix))).set(name, types);
}
export function restoreBinding(state: Symbols, original: Symbols, name: string): Symbols {
  const value = bind(state, name, original.get(name) ?? new Set(["?"]));
  if (!original.has(name)) value.delete(name);
  const prefix = `\0${JSON.stringify(name)}:`;
  for (const [key, types] of original) if (key.startsWith(prefix)) value.set(key, types);
  return value;
}
export function mergeSymbols(states: Symbols[], hooks: TypeHooks): Symbols {
  const result: Symbols = new Map();
  const names = new Set(states.flatMap((state) => [...state.keys()]));
  for (const name of names) {
    // A path fact is valid after a join only when every branch still supplies it.
    if (name.startsWith("\0") && states.some((state) => !state.has(name))) continue;
    result.set(
      name,
      new Set(states.flatMap((state) => [...(state.get(name) ?? hooks.root(name))])),
    );
  }
  return result;
}
const linkTypes: Readonly<Record<string, string>> = {
  article_link: "article",
  blog_link: "blog",
  collection_link: "collection",
  metaobject_link: "metaobject",
  page_link: "page",
  policy_link: "policy",
  product_link: "product",
};
export function baseType(type: string): string {
  return linkObjectType(type) !== undefined ? "link" : type;
}
export function linkObjectType(type: string): string | undefined {
  return type.startsWith("link#") && Object.hasOwn(linkTypes, type.slice(5))
    ? linkTypes[type.slice(5)]
    : undefined;
}
/** Constraints come only from known native element types and literal predicates. */
export function filterElementTypes(
  types: Set<string>,
  args: LiquidArgument[],
  positive: boolean,
): Set<string> {
  const property = args[0],
    value = args[1];
  if (property?.type !== NodeTypes.String || value?.type !== NodeTypes.String) return types;
  const result = new Set<string>();
  for (const type of types) {
    if (!type.endsWith("[]")) {
      result.add("?");
      continue;
    }
    const element = type.slice(0, -2);
    if (
      property.value === "type" &&
      Object.hasOwn(linkTypes, value.value) &&
      baseType(element) === "link"
    ) {
      const selected = linkObjectType(element);
      if (selected !== undefined) {
        if ((selected === linkTypes[value.value]) === positive) result.add(type);
      } else result.add(positive ? `link#${value.value}[]` : type);
    } else if (
      property.value === "object_type" &&
      searchKinds.has(value.value) &&
      searchKinds.has(element)
    ) {
      if ((element === value.value) === positive) result.add(type);
    } else if (
      property.value === "media_type" &&
      mediaKinds.has(value.value) &&
      (element === "media" || mediaKinds.has(element))
    ) {
      for (const kind of element === "media" ? mediaKinds : [element])
        if ((kind === value.value) === positive) result.add(`${kind}[]`);
    } else result.add(type);
  }
  return result.size ? result : new Set(["nil[]"]);
}
const searchKinds = new Set(["product", "article", "page"]);
const mediaKinds = new Set(["image", "video", "external_video", "model"]);

export function narrowValue(
  expression: LiquidExpression,
  literal: LiquidExpression,
  positive: boolean,
  symbols: Symbols,
  hooks: TypeHooks,
): Symbols {
  if (expression.type !== NodeTypes.VariableLookup || literal.type !== NodeTypes.String)
    return symbols;
  const property = expression.lookups.at(-1);
  if (property?.type !== NodeTypes.String) return symbols;
  const parent = { ...expression, lookups: expression.lookups.slice(0, -1) };
  const types = hooks.lookup(parent, symbols);
  let key = lookupKey(parent);
  let result: Set<string>;
  if (
    property.value === "type" &&
    Object.hasOwn(linkTypes, literal.value) &&
    [...types].some((type) => baseType(type) === "link") &&
    [...types].every((type) => ["link", "nil", "?"].includes(baseType(type)))
  ) {
    const target = {
      ...expression,
      lookups: [...parent.lookups, { ...property, value: "object" }],
    };
    key = lookupKey(target);
    const objectTypes = hooks.lookup(target, symbols);
    const selected = linkTypes[literal.value];
    const matchingLink = [...types].some(
      (type) => type === "link" || linkObjectType(type) === selected,
    );
    result = positive
      ? new Set([...(matchingLink ? [selected ?? "?"] : []), ...(types.has("?") ? ["?"] : [])])
      : new Set([...objectTypes].filter((type) => type !== selected));
    if (positive) {
      const parentKey = lookupKey(parent);
      if (parentKey) {
        const parentTypes = new Set<string>();
        if (matchingLink) parentTypes.add(`link#${literal.value}`);
        if (types.has("?")) parentTypes.add("?");
        symbols = new Map(symbols).set(
          parentKey,
          parentTypes.size ? parentTypes : new Set(["nil"]),
        );
      }
    }
  } else if (property.value === "object_type" && searchKinds.has(literal.value)) {
    if (![...types].some((type) => searchKinds.has(type))) return symbols;
    result = new Set(
      [...types].filter((type) => !searchKinds.has(type) || (type === literal.value) === positive),
    );
  } else if (property.value === "media_type" && mediaKinds.has(literal.value)) {
    const expanded = new Set(
      [...types].flatMap((type) => (type === "media" ? [...mediaKinds] : [type])),
    );
    if (![...expanded].some((type) => mediaKinds.has(type))) return symbols;
    result = new Set(
      [...expanded].filter(
        (type) => !mediaKinds.has(type) || (type === literal.value) === positive,
      ),
    );
  } else return symbols;
  if (!key) return symbols;
  return new Map(symbols).set(key, result.size ? result : new Set(["nil"]));
}
export function narrowCondition(
  expression: LiquidConditionalExpression,
  positive: boolean,
  symbols: Symbols,
  hooks: TypeHooks,
): Symbols {
  if (expression.type === NodeTypes.LogicalExpression) {
    if ((expression.relation === "and") === positive)
      return narrowCondition(
        expression.right,
        positive,
        narrowCondition(expression.left, positive, symbols, hooks),
        hooks,
      );
    return mergeSymbols(
      [
        narrowCondition(expression.left, positive, symbols, hooks),
        narrowCondition(expression.right, positive, symbols, hooks),
      ],
      hooks,
    );
  }
  if (expression.type !== NodeTypes.Comparison || !["==", "!="].includes(expression.comparator))
    return symbols;
  const matches = expression.comparator === "==" ? positive : !positive;
  if (expression.left.type === NodeTypes.String)
    return narrowValue(expression.right, expression.left, matches, symbols, hooks);
  return narrowValue(expression.left, expression.right, matches, symbols, hooks);
}
