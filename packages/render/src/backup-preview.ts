import { type LiquidHtmlNode, NodeTypes, toLiquidHtmlAST, walk } from "@shopify/liquid-html-parser";
import { decodeHTMLAttribute, escapeAttribute } from "entities";
import { type Context, Drop, isTruthy, type Liquid, toPromise } from "liquidjs";
import { isCollectionProductList, liquidObjectKind } from "../../data/src/objects.js";

export interface BackupPreviewOptions {
  /** Explicit host policy for older captures, never a claimed captured shop format. */
  standardMoneyFormat?: boolean;
}

class UnknownBackupValue extends Drop {
  valueOf() {
    return undefined;
  }
  override liquidMethodMissing() {
    return this;
  }
}
class UnknownCapturedValue extends UnknownBackupValue {
  constructor(readonly output: string) {
    super();
  }
}
export function capturedBackupOutput(value: unknown): string | undefined {
  return value instanceof UnknownCapturedValue ? value.output : undefined;
}
export function unknownBackupValue(value: unknown): boolean {
  return value instanceof UnknownBackupValue;
}
const unknown = new UnknownBackupValue();
export function unknownBackupFact(): unknown {
  return unknown;
}
const guardedProperties = new Set([
  "available",
  "price",
  "price_min",
  "price_max",
  "price_varies",
  "unit_price",
  "unit_price_measurement",
  "compare_at_price",
  "compare_at_price_min",
  "compare_at_price_max",
  "compare_at_price_varies",
  "selected_or_first_available_variant",
  "first_available_variant",
]);

/** These are neutral slots; the embedding application supplies its own licensed artwork. */
export const backupImagePlaceholder =
  '<span aria-hidden="true" style="position:absolute;inset:0;display:grid;place-items:center;color:rgba(var(--color-foreground,0,0,0),.22);background:rgba(var(--color-foreground,0,0,0),.035)"><span data-sop-backup-image-placeholder aria-hidden="true" style="display:inline-block;width:24px;height:24px"></span></span>';
const backupPriceBar =
  '<span data-sop-backup-price-placeholder aria-hidden="true" style="visibility:visible;position:absolute;inset-inline-start:0;top:4px;width:38%;height:12px;border-radius:3px;background:rgba(var(--color-foreground,0,0,0),.1)"></span>';
const backupPricePlaceholder = `<span aria-hidden="true" style="display:block;position:relative;visibility:hidden">&nbsp;${backupPriceBar}</span>`;

/**
 * Unknown commercial facts stay unknown through Liquid assignments and defaults. This policy is
 * request-local and opt-in; ordinary theme preview retains Shopify/Liquid's normal nil behavior.
 */
export class BackupPreviewGuard {
  constructor(private readonly diagnostic: (message: string) => void) {}
  private readonly contexts = new WeakMap<Context, { reads: number }>();
  private unknownReads = 0;
  private readonly priceFiles = new Map<string, boolean>();
  private readonly unitPriceRegions = new Map<
    string,
    { start: number; end: number; open: string; close: string }
  >();
  private readonly markerNamespace = Array.from(
    globalThis.crypto.getRandomValues(new Uint32Array(4)),
    (value) => value.toString(16).padStart(8, "0"),
  ).join("");
  private readonly selectedPriceFiles = new Set<string>();
  private readonly derivedCollectionLists = new WeakSet<unknown[]>();
  private readonly cardGlobals = new WeakSet<object>();

  /** A missing card owns no ambient page product; explicit snippet bindings still take priority. */
  enterSnippet(
    file: string,
    context: Context,
    bindings: Record<string, unknown> = {},
  ): (() => void) | undefined {
    const isCard = file === "snippets/card-product.liquid";
    const card: unknown = isCard ? context.getSync(["card_product"]) : undefined;
    const missing = isCard && (!isTruthy(card, context) || unknownBackupValue(card));
    if (!missing && !this.cardGlobals.has(context.globals)) return;
    const explicitProduct = Object.hasOwn(bindings, "product");
    if (!isCard && !explicitProduct) return;
    const bound: unknown = explicitProduct
      ? bindings.product
      : isCard && liquidObjectKind(card) === "product"
        ? card
        : missing
          ? null
          : context.getSync(["product"]);
    const product = unknownBackupValue(bound) || isTruthy(bound, context) ? bound : null;
    const previous = context.globals;
    // Isolated render contexts inherit globals; includes also need a local mask over their caller.
    const globals = Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(previous),
        product: { value: product, writable: true, enumerable: true, configurable: true },
      },
    );
    this.cardGlobals.add(globals);
    context.globals = globals;
    // Assign/capture write to bottom(); a pushed mask would incorrectly outrank those writes.
    const locals = isCard ? context.bottom() : undefined;
    const original = locals && Object.getOwnPropertyDescriptor(locals, "product");
    if (locals) locals.product = product;
    const normalized = explicitProduct && bindings.product !== product;
    const binding = normalized ? Object.getOwnPropertyDescriptor(bindings, "product") : undefined;
    if (normalized) bindings.product = product;
    return () => {
      if (locals) {
        if (original) Object.defineProperty(locals, "product", original);
        else delete locals.product;
      }
      if (binding) Object.defineProperty(bindings, "product", binding);
      context.globals = previous;
    };
  }

  private collectionList(value: unknown): value is unknown[] {
    return (
      isCollectionProductList(value) ||
      (Array.isArray(value) && this.derivedCollectionLists.has(value))
    );
  }
  skipLoop(value: unknown): boolean {
    return unknownBackupValue(value) || (this.collectionList(value) && value.length === 0);
  }
  private unknown(context: Context): UnknownBackupValue {
    this.prepare(context);
    const state = this.contexts.get(context);
    if (!state) throw new Error("Backup context guard is not initialized");
    state.reads++;
    this.unknownReads++;
    return unknown;
  }
  /** Keep captured list completeness and uncertainty across Liquid's value pipeline. */
  wrapFilters(engine: Liquid): void {
    const guard = this;
    const transforms = new Set([
      "sort",
      "sort_natural",
      "reverse",
      "compact",
      "uniq",
      "where",
      "reject",
      "find",
      "find_index",
      "has",
      "map",
      "concat",
      "slice",
    ]);
    for (const [name, native] of Object.entries(engine.filters)) {
      if (typeof native !== "function") continue;
      engine.registerFilter(name, async function (input: unknown, ...args: unknown[]) {
        if (unknownBackupValue(input)) return guard.unknown(this.context);
        const lists = [input, ...args].filter((value) => guard.collectionList(value));
        if (transforms.has(name) && lists.some((value) => value.includes(null))) {
          guard.diagnostic(
            `Filter ${name} omitted: missing collection members cannot be filtered or reordered.`,
          );
          return guard.unknown(this.context);
        }
        const before = guard.reads(this.context);
        const result: unknown = await toPromise(native.call(this, input, ...args));
        if (guard.reads(this.context) !== before || unknownBackupValue(result))
          return guard.unknown(this.context);
        if (Array.isArray(result) && lists.length > 0) guard.derivedCollectionLists.add(result);
        return result;
      });
    }
  }

  prepare(context: Context): void {
    if (this.contexts.has(context)) return;
    const state = { reads: 0 };
    this.contexts.set(context, state);
    const guard = this;
    const read = context.readProperty;
    context.readProperty = function (
      object: Parameters<Context["readProperty"]>[0],
      key: Parameters<Context["readProperty"]>[1],
    ) {
      const value: unknown = read.call(this, object, key);
      if (unknownBackupValue(value) || unknownBackupValue(object)) {
        state.reads++;
        guard.unknownReads++;
        return unknownBackupValue(value) ? value : unknown;
      }
      if (
        key === "products" &&
        value === undefined &&
        liquidObjectKind(object) === "collection" &&
        typeof read.call(this, object, "all_products_count") === "number"
      ) {
        state.reads++;
        guard.unknownReads++;
        return unknown;
      }
      if (
        guardedProperties.has(String(key)) &&
        (object === undefined ||
          object === null ||
          (value === undefined && ["product", "variant"].includes(liquidObjectKind(object) ?? "")))
      ) {
        state.reads++;
        guard.unknownReads++;
        return unknown;
      }
      return value;
    };
  }
  reads(context: Context): number {
    this.prepare(context);
    const state = this.contexts.get(context);
    if (!state) throw new Error("Backup context guard is not initialized");
    return state.reads;
  }
  captureReads(): number {
    return this.unknownReads;
  }
  assignment(context: Context, before: number, key: string | undefined): void {
    if (
      key &&
      this.reads(context) !== before &&
      !(context.bottom()[key] instanceof UnknownCapturedValue)
    )
      context.bottom()[key] = unknown;
  }
  capture(context: Context, before: number, key: string | undefined): void {
    if (!key || this.captureReads() === before) return;
    const output: unknown = context.bottom()[key];
    context.bottom()[key] = new UnknownCapturedValue(typeof output === "string" ? output : "");
  }

  unitRegion(file: string) {
    return this.unitPriceRegions.get(file);
  }
  stripUnitMarkers(html: string): string {
    for (const region of this.unitPriceRegions.values())
      html = html.replaceAll(region.open, "").replaceAll(region.close, "");
    return html;
  }
  /** The markers execute at the proven source node, preserving identity across branches/snippets. */
  priceRegions(file: string, html: string, context: Context): string {
    const proof = this.unitPriceRegions.get(file);
    if (!proof) return html;
    const clean = () => html.replaceAll(proof.open, "").replaceAll(proof.close, "");
    if (!html.includes(proof.open) && !html.includes(proof.close)) return html;
    const measurement: unknown = context.getSync([
      "product",
      "selected_or_first_available_variant",
      "unit_price_measurement",
    ]);
    const amount: unknown = context.getSync([
      "product",
      "selected_or_first_available_variant",
      "unit_price",
    ]);
    if (
      measurement === null ||
      (measurement !== undefined &&
        !unknownBackupValue(measurement) &&
        amount !== undefined &&
        amount !== null &&
        !unknownBackupValue(amount))
    )
      return clean();
    const starts: { start: number; end: number }[] = [],
      ends: { start: number; end: number }[] = [],
      regions: { start: number; end: number }[] = [];
    try {
      walk(
        toLiquidHtmlAST(html, { mode: "tolerant", allowUnclosedDocumentNode: false }),
        (node) => {
          if (node.type === NodeTypes.HtmlComment) {
            const markup = html.slice(node.position.start, node.position.end);
            if (markup === proof.open) starts.push(node.position);
            if (markup === proof.close) ends.push(node.position);
          }
          if (node.type === NodeTypes.HtmlElement && hasClass(node, "unit-price"))
            regions.push(node.position);
        },
      );
    } catch {
      this.diagnostic(`Unit-price omission unavailable: ${file} has no parseable rendered region.`);
      return clean();
    }
    const start = starts.length === 1 ? starts[0] : undefined,
      end = ends.length === 1 ? ends[0] : undefined;
    if (
      !start ||
      !end ||
      !regions.some((region) => region.start === start.end && region.end === end.start)
    ) {
      this.diagnostic(
        `Unit-price omission unavailable: ${file} has no unique source-bound rendered region.`,
      );
      return clean();
    }
    return `${html.slice(0, start.start)}${html.slice(end.end)}`;
  }

  /** A proved empty price body keeps the theme's own wrappers, font and line boxes. */
  emptyPrice(file: string, html: string): string {
    try {
      const ast = toLiquidHtmlAST(html, { mode: "tolerant", allowUnclosedDocumentNode: false });
      const roots = ast.children.filter(
        (node) =>
          node.type !== NodeTypes.HtmlComment &&
          !(node.type === NodeTypes.TextNode && node.value.trim() === ""),
      );
      const root = roots.length === 1 ? roots[0] : undefined;
      if (root?.type !== NodeTypes.HtmlElement || !hasClass(root, "price"))
        return backupPricePlaceholder;
      const edits: { start: number; end: number; value: string }[] = [];
      walk(root, (node, parent) => {
        if (node.type === NodeTypes.HtmlElement) {
          let style = "";
          for (const attribute of node.attributes) {
            if (!("name" in attribute) || !Array.isArray(attribute.name)) continue;
            const name = attribute.name
              .map((part) => (part.type === NodeTypes.TextNode ? part.value : ""))
              .join("")
              .toLowerCase();
            if (
              !["style", "aria-hidden", "tabindex", "contenteditable", "autofocus"].includes(name)
            )
              continue;
            if (name === "style" && "value" in attribute)
              style = decodeHTMLAttribute(
                attribute.value
                  .map((part) => html.slice(part.position.start, part.position.end))
                  .join(""),
              );
            edits.push({ ...attribute.position, value: "" });
          }
          const position = node === root ? "position:relative;" : "";
          const at = node.blockStartPosition.end - 1;
          edits.push({
            start: at,
            end: at,
            value: ` aria-hidden="true" style="${escapeAttribute(`${style};${position}visibility:hidden`)}"`,
          });
          if (node.children.every((child) => child.type !== NodeTypes.HtmlElement))
            edits.push({
              start: node.blockStartPosition.end,
              end: node.blockEndPosition.start,
              value: "&nbsp;",
            });
        } else if (
          node.type === NodeTypes.TextNode &&
          parent?.type === NodeTypes.HtmlElement &&
          parent.children.includes(node) &&
          parent.children.some((child) => child.type === NodeTypes.HtmlElement) &&
          node.value.trim() !== ""
        )
          edits.push({ ...node.position, value: "&nbsp;" });
      });
      edits.push({
        start: root.blockEndPosition.start,
        end: root.blockEndPosition.start,
        value: backupPriceBar,
      });
      for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
        html = `${html.slice(0, edit.start)}${edit.value}${html.slice(edit.end)}`;
      return html;
    } catch {
      this.diagnostic(
        `Price placeholder uses inherited line height: ${file} has no parseable wrapper.`,
      );
      return backupPricePlaceholder;
    }
  }

  /** Older card snippets have an empty media ratio box but no placeholder_svg_tag call. */
  cardPlaceholder(file: string, html: string, context: Context): string {
    if (
      !/^snippets\/card-product\.liquid$/.test(file) ||
      isTruthy(context.getSync(["card_product"]), context) ||
      html.includes("data-sop-backup-image-placeholder")
    )
      return html;
    const positions: number[] = [];
    try {
      walk(
        toLiquidHtmlAST(html, { mode: "tolerant", allowUnclosedDocumentNode: false }),
        (node) => {
          if (node.type !== NodeTypes.HtmlElement) return;
          for (const attribute of node.attributes) {
            if (
              attribute.type !== NodeTypes.AttrDoubleQuoted &&
              attribute.type !== NodeTypes.AttrSingleQuoted &&
              attribute.type !== NodeTypes.AttrUnquoted
            )
              continue;
            if (
              !attribute.name.every((part) => part.type === NodeTypes.TextNode) ||
              attribute.name
                .map((part) => html.slice(part.position.start, part.position.end))
                .join("") !== "class"
            )
              continue;
            if (!attribute.value.every((part) => part.type === NodeTypes.TextNode)) continue;
            const classes = attribute.value
              .map((part) => html.slice(part.position.start, part.position.end))
              .join("")
              .split(/\s+/);
            if (classes.includes("card__inner")) positions.push(node.blockStartPosition.end);
          }
        },
      );
    } catch {
      // No safe card boundary: retain the useful body rather than inventing a new layout.
      this.diagnostic(`Image placeholder omitted: ${file} has no parseable card media boundary.`);
      return html;
    }
    const at = positions.length === 1 ? positions[0] : undefined;
    if (at === undefined) {
      this.diagnostic(
        `Image placeholder omitted: ${file} has no unique card__inner media boundary.`,
      );
      return html;
    }
    return `${html.slice(0, at)}${backupImagePlaceholder}${html.slice(at)}`;
  }

  /** A bounded price snippet may be removed without removing surrounding photos or titles. */
  priceSnippet(
    file: string,
    source: string,
    context: Context,
  ): { html: string } | { commonPrice: true } | { emptyPrice: true } | undefined {
    if (!/^snippets\/(?:[\w-]+-)?price(?:-[\w-]+)?\.liquid$/.test(file)) return;
    if (!this.priceFiles.has(file)) {
      let money = false,
        product = false,
        unrelated = false;
      try {
        const ast = toLiquidHtmlAST(source, { mode: "tolerant", allowUnclosedDocumentNode: false });
        const parents = new Map<LiquidHtmlNode, LiquidHtmlNode | undefined>();
        walk(ast, (node, parent) => parents.set(node, parent));
        const inAttribute = (node: LiquidHtmlNode): boolean => {
          let parent = parents.get(node);
          while (parent) {
            if (
              [
                NodeTypes.AttrDoubleQuoted,
                NodeTypes.AttrSingleQuoted,
                NodeTypes.AttrUnquoted,
              ].includes(parent.type)
            )
              return true;
            parent = parents.get(parent);
          }
          return false;
        };
        type Variable = Extract<LiquidHtmlNode, { type: NodeTypes.LiquidVariable }>;
        type Expression = Variable["expression"];
        const assignments = new Map<string, Variable[]>();
        let mutableProductBinding = false;
        walk(ast, (node) => {
          if (node.type === NodeTypes.AssignMarkup && node.name === "product")
            mutableProductBinding = true;
          if (node.type === NodeTypes.ForMarkup && node.variableName === "product")
            mutableProductBinding = true;
          if (node.type === NodeTypes.LiquidTag) {
            if (["include", "section", "sections", "content_for"].includes(node.name))
              mutableProductBinding = true;
            if (
              ["capture", "increment", "decrement"].includes(node.name) &&
              typeof node.markup !== "string" &&
              node.markup !== null &&
              "type" in node.markup &&
              node.markup.type === NodeTypes.VariableLookup &&
              node.markup.name === "product"
            )
              mutableProductBinding = true;
          }
          if (node.type === NodeTypes.AssignMarkup)
            assignments.set(node.name, [...(assignments.get(node.name) ?? []), node.value]);
        });
        let selectedOutput = false,
          independentOutput = false;
        const mainPrices = new Set([
          "price",
          "price_min",
          "price_max",
          "price_varies",
          "compare_at_price",
          "compare_at_price_min",
          "compare_at_price_max",
          "compare_at_price_varies",
        ]);
        const numericFilters = new Set([
          "default",
          "plus",
          "minus",
          "times",
          "divided_by",
          "modulo",
          "round",
          "ceil",
          "floor",
          "abs",
          "at_least",
          "at_most",
        ]);
        const translation = (value: string, unit: boolean) =>
          unit
            ? ["products.product.price.unit_price", "accessibility.unit_price_separator"].includes(
                value,
              )
            : value.startsWith("products.product.price.") ||
              [
                "products.product.on_sale",
                "products.product.sold_out",
                "accessibility.unit_price_separator",
              ].includes(value);
        const valueProofs = new Map<string, { safe: boolean; main: boolean; selected: boolean }>();
        function safeVariable(
          value: Variable,
          suffix: string[],
          unit: boolean,
          facts: { main: boolean; selected: boolean },
          depth = 0,
        ): boolean {
          if (depth > 30 || (suffix.length > 0 && value.filters.length > 0)) return false;
          const cacheKey = `${value.position.start}:${unit}:${depth}:${JSON.stringify(suffix)}`;
          const cached = valueProofs.get(cacheKey);
          if (cached) {
            facts.main ||= cached.main;
            facts.selected ||= cached.selected;
            return cached.safe;
          }
          const localFacts = { main: false, selected: false };
          const translated = value.filters.some((filter) =>
            ["t", "translate"].includes(filter.name),
          );
          const expression = value.expression;
          const safe =
            translated && expression.type === NodeTypes.String
              ? translation(expression.value, unit)
              : safeExpression(expression, suffix, value.position.start, unit, localFacts, depth);
          const result =
            safe &&
            value.filters.every((filter) => {
              if (
                !/^money(?:_|$)/.test(filter.name) &&
                !numericFilters.has(filter.name) &&
                !["t", "translate"].includes(filter.name)
              )
                return false;
              return filter.args.every((argument) => {
                const item = argument.type === NodeTypes.NamedArgument ? argument.value : argument;
                return (
                  [NodeTypes.Number, NodeTypes.LiquidLiteral].includes(item.type) ||
                  safeExpression(item, [], value.position.start, unit, localFacts, depth + 1)
                );
              });
            });
          valueProofs.set(cacheKey, { safe: result, ...localFacts });
          facts.main ||= localFacts.main;
          facts.selected ||= localFacts.selected;
          return result;
        }
        function safeExpression(
          expression: Expression,
          suffix: string[],
          at: number,
          unit: boolean,
          facts: { main: boolean; selected: boolean },
          depth: number,
        ): boolean {
          if (expression.type !== NodeTypes.VariableLookup || depth > 30) return false;
          if (!expression.lookups.every((lookup) => lookup.type === NodeTypes.String)) return false;
          const parts = expression.lookups.map((lookup) =>
            lookup.type === NodeTypes.String ? lookup.value : "",
          );
          const name = expression.name ?? parts.shift();
          const path = [...parts, ...suffix];
          if (name !== "product") {
            const definitions = name
              ? assignments.get(name)?.filter((value) => value.position.start < at)
              : undefined;
            return (
              !!definitions?.length &&
              definitions.every((value) => safeVariable(value, path, unit, facts, depth + 1))
            );
          }
          const selected = [
            "selected_or_first_available_variant",
            "selected_variant",
            "first_available_variant",
          ].includes(path[0] ?? "");
          if (selected) path.shift();
          const field = path[0] ?? "";
          if (path.length === 1 && mainPrices.has(field) && !unit) {
            facts.main = true;
            facts.selected ||= selected;
            return true;
          }
          return (
            (path.length === 1 && (field === "unit_price" || (!unit && field === "available"))) ||
            (path.length === 2 &&
              field === "unit_price_measurement" &&
              [
                "reference_value",
                "reference_unit",
                "quantity_value",
                "quantity_unit",
                "measured_type",
              ].includes(path[1] ?? ""))
          );
        }
        const unrelatedBody = (root: LiquidHtmlNode, unit: boolean): boolean => {
          let rejected = false;
          walk(root, (node, parent) => {
            if (
              [
                NodeTypes.HtmlVoidElement,
                NodeTypes.HtmlSelfClosingElement,
                NodeTypes.HtmlRawNode,
              ].includes(node.type)
            )
              rejected = true;
            if (node.type === NodeTypes.HtmlElement) {
              const tag = node.name
                .map((part) => (part.type === NodeTypes.TextNode ? part.value : ""))
                .join("");
              if (!["div", "span", "small", "s", "b", "i"].includes(tag)) rejected = true;
            }
            if (node.type === NodeTypes.LiquidRawTag && !["comment", "doc"].includes(node.name))
              rejected = true;
            if (
              node.type === NodeTypes.LiquidTag &&
              ![
                "assign",
                "if",
                "unless",
                "case",
                "liquid",
                "capture",
                "for",
                "break",
                "continue",
                "echo",
              ].includes(node.name)
            )
              rejected = true;
            if (
              node.type === NodeTypes.TextNode &&
              parent &&
              "children" in parent &&
              parent.children?.includes(node) &&
              !inAttribute(node) &&
              !/^(?:\s|\/|&nbsp;)*$/.test(node.value)
            )
              rejected = true;
            const output =
              node.type === NodeTypes.LiquidVariableOutput
                ? node.markup
                : node.type === NodeTypes.LiquidTag && node.name === "echo"
                  ? node.markup
                  : undefined;
            if (output !== undefined && !inAttribute(node)) {
              const facts = { main: false, selected: false };
              if (
                typeof output === "string" ||
                output === null ||
                !("type" in output) ||
                output.type !== NodeTypes.LiquidVariable ||
                !safeVariable(output, [], unit, facts)
              )
                rejected = true;
              else if (!unit && facts.main) {
                if (facts.selected) selectedOutput = true;
                else independentOutput = true;
              }
            }
          });
          return rejected;
        };
        unrelated = unrelatedBody(ast, false) || mutableProductBinding;
        const provenUnits: { start: number; end: number }[] = [];
        walk(ast, (node) => {
          if (node.type === NodeTypes.LiquidFilter && /^money(?:_|$)/.test(node.name)) money = true;
          if (node.type === NodeTypes.VariableLookup && node.name === "product") product = true;
          if (
            node.type !== NodeTypes.HtmlElement ||
            !hasClass(node, "unit-price") ||
            unrelatedBody(node, true)
          )
            return;
          let measurement = false,
            amount = false;
          walk(node, (child) => {
            if (child.type !== NodeTypes.VariableLookup || child.name !== "product") return;
            const [selected, field] = child.lookups;
            if (
              selected?.type !== NodeTypes.String ||
              selected.value !== "selected_or_first_available_variant" ||
              field?.type !== NodeTypes.String
            )
              return;
            measurement ||= field.value === "unit_price_measurement";
            amount ||= field.value === "unit_price";
          });
          let ancestor = parents.get(node);
          while (ancestor) {
            // Do not insert transport markup into a value a theme can later escape or serialize.
            if (
              ancestor.type === NodeTypes.LiquidTag &&
              ["capture", "for", "tablerow"].includes(ancestor.name)
            )
              return;
            ancestor = parents.get(ancestor);
          }
          if (measurement && amount) provenUnits.push(node.position);
        });
        const unit =
          !mutableProductBinding && provenUnits.length === 1 ? provenUnits[0] : undefined;
        if (unit) {
          const marker = `sop-backup-unit-${this.markerNamespace}-${this.unitPriceRegions.size}`;
          this.unitPriceRegions.set(file, {
            ...unit,
            open: `<!--${marker}:start-->`,
            close: `<!--${marker}:end-->`,
          });
        }
        if (selectedOutput && !independentOutput) this.selectedPriceFiles.add(file);
      } catch {
        // Unrecognized syntax uses the ordinary renderer and its granular value guards.
        unrelated = true;
      }
      this.priceFiles.set(file, money && product && !unrelated);
    }
    if (!this.priceFiles.get(file)) return;
    const product: unknown = context.getSync(["product"]);
    if (product === null || product === undefined || unknownBackupValue(product))
      return { emptyPrice: true };
    if (this.selectedPriceFiles.has(file) && isTruthy(context.getSync(["use_variant"]), context)) {
      const selected: unknown = context.getSync(["product", "selected_or_first_available_variant"]);
      if (selected === undefined || unknownBackupValue(selected)) {
        const variants: unknown = context.getSync(["product", "variants"]);
        // This changes only a bounded price snippet's target. It does not select a variant,
        // fabricate a product or claim a common compare-at value when those values differ.
        if (
          liquidObjectKind(product) === "product" &&
          Array.isArray(variants) &&
          variants.length > 0
        ) {
          const facts = variants.map((variant: unknown) => ({
            price:
              variant && typeof variant === "object" && "price" in variant
                ? variant.price
                : undefined,
            compare:
              variant && typeof variant === "object" && "compare_at_price" in variant
                ? variant.compare_at_price
                : undefined,
          }));
          const first = facts[0];
          if (
            first &&
            typeof first.price === "number" &&
            Number.isFinite(first.price) &&
            (first.compare === null || typeof first.compare === "number") &&
            facts.every((fact) => fact.price === first.price && fact.compare === first.compare)
          )
            return { commonPrice: true };
        }
        return { html: "" };
      }
    }
    return;
  }
}

/** Read only a literal class token; dynamic expressions cannot establish a semantic boundary. */
function hasClass(
  node: Extract<LiquidHtmlNode, { type: NodeTypes.HtmlElement }>,
  name: string,
): boolean {
  return node.attributes.some((attribute) => {
    if (
      ![NodeTypes.AttrDoubleQuoted, NodeTypes.AttrSingleQuoted, NodeTypes.AttrUnquoted].includes(
        attribute.type,
      ) ||
      !("value" in attribute)
    )
      return false;
    if (
      !attribute.name.every((part) => part.type === NodeTypes.TextNode) ||
      attribute.name
        .map((part) => (part.type === NodeTypes.TextNode ? part.value : ""))
        .join("") !== "class"
    )
      return false;
    return attribute.value.some(
      (part) => part.type === NodeTypes.TextNode && part.value.split(/\s+/).includes(name),
    );
  });
}
