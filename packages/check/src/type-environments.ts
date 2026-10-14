import {
  type LiquidExpression,
  type LiquidHtmlNode,
  type LiquidVariable,
  NodeTypes,
  walk,
} from "@shopify/liquid-html-parser";

export type Symbols = Map<string, Set<string>>;
interface TypeHooks {
  lookup(expression: LiquidExpression, symbols: Symbols): Set<string>;
  root(name: string): Set<string>;
  property(type: string, name: string): string[] | undefined;
}
/** Each lookup sees the bindings at its statement; branches retain every possible outcome. */
export function variableEnvironments(
  ast: LiquidHtmlNode,
  hooks: TypeHooks,
): WeakMap<LiquidHtmlNode, Symbols> {
  const environments = new WeakMap<LiquidHtmlNode, Symbols>();
  function stamp(node: LiquidHtmlNode, symbols: Symbols) {
    // Descendant statements overwrite these entries with their more specific environments.
    walk(node, (child) => {
      if (child.type === NodeTypes.VariableLookup) environments.set(child, symbols);
    });
  }
  function merge(states: Symbols[]): Symbols {
    const result: Symbols = new Map();
    const names = new Set(states.flatMap((state) => [...state.keys()]));
    for (const name of names)
      result.set(
        name,
        new Set(states.flatMap((state) => [...(state.get(name) ?? hooks.root(name))])),
      );
    return result;
  }
  function infer(value: LiquidVariable, symbols: Symbols): Set<string> {
    let types =
      value.expression.type === NodeTypes.BooleanExpression
        ? new Set(["boolean"])
        : hooks.lookup(value.expression, symbols);
    for (const filter of value.filters) {
      if (filter.name === "default") {
        const fallback = filter.args[0];
        if (fallback && fallback.type !== NodeTypes.NamedArgument)
          types = new Set([...types, ...hooks.lookup(fallback, symbols)]);
      } else if (["first", "last", "find", "find_index"].includes(filter.name)) {
        types =
          filter.name === "find_index"
            ? new Set(["number"])
            : new Set([...types].map((type) => (type.endsWith("[]") ? type.slice(0, -2) : "?")));
      } else if (
        ["where", "reject", "sort", "sort_natural", "reverse", "uniq", "compact"].includes(
          filter.name,
        )
      ) {
        types = new Set([...types].map((type) => (type.endsWith("[]") ? type : "?")));
      } else if (filter.name === "map") {
        const property = filter.args[0];
        const mapped = new Set<string>();
        if (property?.type === NodeTypes.String)
          for (const type of types) {
            for (const result of hooks.property(type.replace(/\[\]$/, ""), property.value) ?? ["?"])
              mapped.add(result === "?" ? result : `${result}[]`);
          }
        types = mapped;
      } else types = new Set(["?"]); // Unknown filter return contracts must stay visible.
    }
    return types.size ? types : new Set(["?"]);
  }
  function sequence(nodes: LiquidHtmlNode[], initial: Symbols): Symbols {
    let symbols = initial;
    for (const node of nodes) {
      stamp(node, symbols);
      if (node.type !== NodeTypes.LiquidTag) {
        if ("children" in node && node.children) symbols = sequence(node.children, symbols);
        continue;
      }
      const markup = node.markup;
      if (Array.isArray(markup) && node.name === "liquid") symbols = sequence(markup, symbols);
      else if (
        markup &&
        typeof markup !== "string" &&
        !Array.isArray(markup) &&
        markup.type === NodeTypes.AssignMarkup
      ) {
        symbols = new Map(symbols).set(markup.name, infer(markup.value, symbols));
      } else if (
        markup &&
        typeof markup !== "string" &&
        !Array.isArray(markup) &&
        markup.type === NodeTypes.ForMarkup
      ) {
        const collection = hooks.lookup(markup.collection, symbols);
        const itemTypes = new Set(
          [...collection].map((type) => (type.endsWith("[]") ? type.slice(0, -2) : "?")),
        );
        let inside = new Map(symbols).set(markup.variableName, itemTypes);
        let states: Symbols[] = [];
        const bodyNodes = (node.children ?? []).filter(
          (branch) => !(branch.type === NodeTypes.LiquidBranch && branch.name === "else"),
        );
        const elseNodes = (node.children ?? []).filter(
          (branch) => branch.type === NodeTypes.LiquidBranch && branch.name === "else",
        );
        const signature = (state: Symbols) =>
          JSON.stringify(
            [...state]
              .map(([name, types]) => [name, [...types].sort()])
              .sort(([a], [b]) => String(a).localeCompare(String(b), "en")),
          );
        // Assignments persist between iterations. Collect loop-carried bindings until
        // stable, retaining the entry state for the first iteration and zero iterations.
        for (let pass = 0; pass <= 64; pass++) {
          if (pass === 64)
            inside = new Map([...inside].map(([name, types]) => [name, new Set([...types, "?"])]));
          states = [sequence(bodyNodes, inside)];
          const carried = merge([inside, ...states]).set(markup.variableName, itemTypes);
          if (signature(carried) === signature(inside) || pass === 64) break;
          inside = carried;
        }
        const restored = states.map((state) => {
          const value = new Map(state);
          if (symbols.has(markup.variableName))
            value.set(markup.variableName, symbols.get(markup.variableName) ?? new Set(["?"]));
          else value.delete(markup.variableName);
          return value;
        });
        const emptyState = elseNodes.length ? sequence(elseNodes, symbols) : symbols;
        symbols = merge([emptyState, ...restored]);
      } else if (["if", "unless", "case"].includes(node.name)) {
        const children = node.children ?? [];
        const states = children.map((branch) => sequence([branch], symbols));
        if (
          !children.some(
            (branch) => branch.type === NodeTypes.LiquidBranch && branch.name === "else",
          )
        )
          states.push(symbols);
        symbols = merge(states.length ? states : [symbols]);
      } else if (node.children) {
        symbols = sequence(node.children, symbols);
        if (
          node.name === "capture" &&
          markup &&
          typeof markup !== "string" &&
          !Array.isArray(markup) &&
          markup.type === NodeTypes.VariableLookup &&
          markup.name
        )
          symbols = new Map(symbols).set(markup.name, new Set(["string"]));
      }
    }
    return symbols;
  }
  sequence([ast], new Map());
  return environments;
}
