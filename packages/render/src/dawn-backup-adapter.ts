import { type LiquidHtmlNode, NodeTypes, toLiquidHtmlAST, walk } from "@shopify/liquid-html-parser";
import { decodeHTMLAttribute, escapeAttribute } from "entities";
import { type Context, isTruthy } from "liquidjs";
import { liquidObjectKind } from "../../data/src/objects.js";
import { unknownBackupValue } from "./backup-values.js";

/** Trusted host markup; the adapter does not sanitize or supply a visual design. */
export interface DawnBackupPreviewOptions {
  imagePlaceholder?: string;
  pricePlaceholder?: string;
  hideSampleText?: boolean;
}

/** Explicit Dawn compatibility for static saved-content previews. */
export class DawnBackupAdapter {
  constructor(
    private readonly options: DawnBackupPreviewOptions,
    private readonly diagnostic: (message: string) => void,
  ) {}
  imagePlaceholder(): string {
    return this.options.imagePlaceholder ?? "";
  }
  recordMoney(context: Context, value: string): void {
    this.moneyState(context).values.add(value.trim());
  }
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
  private readonly cardGlobals = new WeakSet<object>();
  private readonly variantControls = new Map<
    string,
    { start: number; end: number; open: string; close: string } | null
  >();
  prepareVariantPicker(file: string, source: string): void {
    if (file !== "snippets/product-variant-picker.liquid" || this.variantControls.has(file)) return;
    this.variantControls.set(file, null);
    try {
      const ast = toLiquidHtmlAST(source, { mode: "tolerant", allowUnclosedDocumentNode: false });
      let mutable = false;
      const controls: Extract<LiquidHtmlNode, { type: NodeTypes.HtmlElement }>[] = [];
      walk(ast, (node) => {
        if (
          (node.type === NodeTypes.AssignMarkup && node.name === "product") ||
          (node.type === NodeTypes.ForMarkup && node.variableName === "product") ||
          (node.type === NodeTypes.LiquidTag && ["include", "capture"].includes(node.name))
        )
          mutable = true;
        if (
          node.type !== NodeTypes.HtmlElement ||
          tagName(node) !== "select" ||
          literalAttribute(node, "name")?.value !== "id" ||
          node.attributes.some((a) => attributeName(a) === "multiple")
        )
          return;
        const loops: Extract<LiquidHtmlNode, { type: NodeTypes.ForMarkup }>[] = [];
        walk(node, (child) => {
          if (child.type === NodeTypes.ForMarkup && lookup(child.collection, "product", "variants"))
            loops.push(child);
        });
        const loop = loops.length === 1 ? loops[0] : undefined;
        if (!loop) return;
        let options = 0,
          bound = true,
          selected = false;
        walk(node, (child) => {
          if (child.type !== NodeTypes.HtmlElement || tagName(child) !== "option") return;
          options++;
          const value = child.attributes.find((a) => attributeName(a) === "value");
          const output =
            value && "value" in value && value.value.length === 1 ? value.value[0] : undefined;
          const variable =
            output?.type === NodeTypes.LiquidVariableOutput && typeof output.markup !== "string"
              ? output.markup
              : undefined;
          bound &&=
            !!variable &&
            !variable.filters.length &&
            lookup(variable.expression, loop.variableName, "id");
          for (const attribute of child.attributes) {
            if (attribute.type !== NodeTypes.LiquidTag || attribute.name !== "if") continue;
            const condition = attribute.markup;
            if (
              !condition ||
              typeof condition === "string" ||
              condition.type !== NodeTypes.Comparison ||
              condition.comparator !== "=="
            )
              continue;
            const boundSelection =
              (lookup(condition.left, loop.variableName) &&
                lookup(condition.right, "product", "selected_or_first_available_variant")) ||
              (lookup(condition.right, loop.variableName) &&
                lookup(condition.left, "product", "selected_or_first_available_variant"));
            walk(attribute, (part) => {
              if (
                boundSelection &&
                (part.type === NodeTypes.AttrEmpty ||
                  part.type === NodeTypes.AttrDoubleQuoted ||
                  part.type === NodeTypes.AttrSingleQuoted ||
                  part.type === NodeTypes.AttrUnquoted) &&
                attributeName(part) === "selected"
              )
                selected = true;
            });
          }
        });
        if (options > 0 && bound && selected) controls.push(node);
      });
      const control = controls.length === 1 ? controls[0] : undefined;
      if (!mutable && control)
        this.variantControls.set(file, {
          ...control.position,
          open: `<!--${this.markerNamespace}:variant:start-->`,
          close: `<!--${this.markerNamespace}:variant:end-->`,
        });
    } catch {
      this.diagnostic(`Variant selection retained: ${file} has no proven control boundary.`);
    }
  }
  variantOptions(file: string, html: string, context: Context): string {
    const proof = this.variantControls.get(file);
    if (!proof) return html;
    const clean = () => html.replaceAll(proof.open, "").replaceAll(proof.close, "");
    const selected: unknown = context.getSync(["product", "selected_or_first_available_variant"]);
    if (selected !== undefined && !unknownBackupValue(selected)) return clean();
    const start = html.indexOf(proof.open),
      end = html.indexOf(proof.close);
    if (
      start < 0 ||
      end < start ||
      start !== html.lastIndexOf(proof.open) ||
      end !== html.lastIndexOf(proof.close)
    )
      return clean();
    const inner = html.slice(start + proof.open.length, end);
    try {
      const ast = toLiquidHtmlAST(inner, { mode: "tolerant", allowUnclosedDocumentNode: false });
      const control = ast.children[0];
      if (
        ast.children.length !== 1 ||
        control?.type !== NodeTypes.HtmlElement ||
        tagName(control) !== "select"
      )
        return clean();
      const edits = [
        {
          start: control.blockStartPosition.end,
          end: control.blockStartPosition.end,
          value:
            '<option value="" selected disabled hidden aria-hidden="true" data-sop-backup-unselected></option>',
        },
        {
          start: control.blockStartPosition.end - 1,
          end: control.blockStartPosition.end - 1,
          value: control.attributes.some((a) => attributeName(a) === "disabled") ? "" : " disabled",
        },
      ];
      walk(control, (node) => {
        if (node.type === NodeTypes.HtmlElement && tagName(node) === "option")
          for (const attribute of node.attributes)
            if (attributeName(attribute) === "selected")
              edits.push({ ...attribute.position, value: "" });
      });
      let output = inner;
      for (const edit of edits.sort((a, b) => b.start - a.start))
        output = `${output.slice(0, edit.start)}${edit.value}${output.slice(edit.end)}`;
      return `${html.slice(0, start)}${output}${html.slice(end + proof.close.length)}`;
    } catch {
      this.diagnostic(`Variant selection retained: ${file} has no source-bound rendered select.`);
      return clean();
    }
  }
  private captureDepth = 0;
  private readonly money = new WeakMap<Context, { values: Set<string>; outputs: number }>();
  private moneyState(context: Context) {
    let state = this.money.get(context);
    if (!state) {
      state = { values: new Set(), outputs: 0 };
      this.money.set(context, state);
    }
    return state;
  }
  moneyOutputs(context: Context): number {
    return this.moneyState(context).outputs;
  }
  recordOutput(context: Context, value: unknown): void {
    const state = this.moneyState(context);
    if (!this.captureDepth && typeof value === "string" && state.values.has(value.trim()))
      state.outputs++;
  }
  captureMoney(): () => void {
    this.captureDepth++;
    return () => {
      this.captureDepth--;
    };
  }
  markKnownPrice(file: string, html: string, context: Context, before: number): string {
    return !this.captureDepth && this.priceFiles.get(file) && this.moneyOutputs(context) > before
      ? `<!--${this.markerNamespace}:price:start-->${html}<!--${this.markerNamespace}:price:end-->`
      : html;
  }
  finishHtml(html: string): string {
    const open = `<!--${this.markerNamespace}:price:start-->`,
      close = `<!--${this.markerNamespace}:price:end-->`;
    const edits: { start: number; end: number; value: string }[] = [];
    if (html.includes(open))
      try {
        walk(
          toLiquidHtmlAST(html, { mode: "tolerant", allowUnclosedDocumentNode: false }),
          (node) => {
            if (
              node.type !== NodeTypes.HtmlElement ||
              !["div", "span"].includes(tagName(node)) ||
              !hasClass(node, "no-js-hidden")
            )
              return;
            if (
              node.attributes.some((a) =>
                /^(?:on|tabindex$|contenteditable$)/.test(attributeName(a)),
              )
            )
              return;
            const role = literalAttribute(node, "role")?.value;
            if (role && role !== "status") return;
            const children = node.children.filter(
              (child) => !(child.type === NodeTypes.TextNode && !child.value.trim()),
            );
            const first = children[0],
              last = children.at(-1);
            if (
              first?.type !== NodeTypes.HtmlComment ||
              last?.type !== NodeTypes.HtmlComment ||
              html.slice(first.position.start, first.position.end) !== open ||
              html.slice(last.position.start, last.position.end) !== close
            )
              return;
            if (
              children.filter(
                (child) =>
                  child.type === NodeTypes.HtmlComment &&
                  [open, close].includes(html.slice(child.position.start, child.position.end)),
              ).length !== 2
            )
              return;
            const classes = literalAttribute(node, "class");
            if (classes)
              edits.push({
                ...classes.node.position,
                value: `class="${escapeAttribute(
                  classes.value
                    .split(/\s+/)
                    .filter((value) => value !== "no-js-hidden")
                    .join(" "),
                )}"`,
              });
          },
        );
      } catch {
        this.diagnostic("Known-price visibility retained: no unambiguous parsed wrapper.");
      }
    for (const edit of edits.sort((a, b) => b.start - a.start))
      html = `${html.slice(0, edit.start)}${edit.value}${html.slice(edit.end)}`;
    return this.stripUnitMarkers(html.replaceAll(open, "").replaceAll(close, ""));
  }

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

  unitRegion(file: string) {
    return this.unitPriceRegions.get(file) ?? this.variantControls.get(file) ?? undefined;
  }
  stripUnitMarkers(html: string): string {
    for (const region of this.unitPriceRegions.values())
      html = html.replaceAll(region.open, "").replaceAll(region.close, "");
    for (const region of this.variantControls.values())
      if (region) html = html.replaceAll(region.open, "").replaceAll(region.close, "");
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
    const fallback = `<span aria-hidden="true" style="display:block;position:relative;visibility:hidden">&nbsp;${this.options.pricePlaceholder ?? ""}</span>`;
    try {
      const ast = toLiquidHtmlAST(html, { mode: "tolerant", allowUnclosedDocumentNode: false });
      const roots = ast.children.filter(
        (node) =>
          node.type !== NodeTypes.HtmlComment &&
          !(node.type === NodeTypes.TextNode && node.value.trim() === ""),
      );
      const root = roots.length === 1 ? roots[0] : undefined;
      if (root?.type !== NodeTypes.HtmlElement || !hasClass(root, "price")) return fallback;
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
        value: this.options.pricePlaceholder ?? "",
      });
      for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
        html = `${html.slice(0, edit.start)}${edit.value}${html.slice(edit.end)}`;
      return html;
    } catch {
      this.diagnostic(
        `Price placeholder uses inherited line height: ${file} has no parseable wrapper.`,
      );
      return fallback;
    }
  }

  /** Older card snippets have an empty media ratio box but no placeholder_svg_tag call. */
  cardPlaceholder(file: string, html: string, context: Context): string {
    if (
      !/^snippets\/card-product\.liquid$/.test(file) ||
      isTruthy(context.getSync(["card_product"]), context) ||
      (this.imagePlaceholder() !== "" && html.includes(this.imagePlaceholder()))
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
    return `${html.slice(0, at)}${this.imagePlaceholder()}${html.slice(at)}`;
  }

  /** A bounded price snippet may be removed without removing surrounding photos or titles. */
  priceSnippet(
    file: string,
    source: string,
    context: Context,
  ): { commonPrice: true } | { emptyPrice: true } | undefined {
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
        // Execute ordinary assignments and branches: an earlier selected alias may be overwritten.
        // Granular value guards omit only the unknown facts actually consumed by the theme.
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

type HtmlElement = Extract<LiquidHtmlNode, { type: NodeTypes.HtmlElement }>;
function tagName(node: HtmlElement): string {
  return node.name.map((part) => (part.type === NodeTypes.TextNode ? part.value : "")).join("");
}
function attributeName(attribute: HtmlElement["attributes"][number]): string {
  return "name" in attribute && Array.isArray(attribute.name)
    ? attribute.name.map((part) => (part.type === NodeTypes.TextNode ? part.value : "")).join("")
    : "";
}
function literalAttribute(node: HtmlElement, name: string) {
  const attribute = node.attributes.find((item) => attributeName(item) === name);
  return attribute &&
    "value" in attribute &&
    attribute.value.every((part) => part.type === NodeTypes.TextNode)
    ? {
        node: attribute,
        value: attribute.value
          .map((part) => (part.type === NodeTypes.TextNode ? part.value : ""))
          .join(""),
      }
    : undefined;
}
function lookup(node: LiquidHtmlNode | undefined, name: string, property?: string): boolean {
  return (
    node?.type === NodeTypes.VariableLookup &&
    node.name === name &&
    node.lookups.length === (property ? 1 : 0) &&
    (!property ||
      (node.lookups[0]?.type === NodeTypes.String && node.lookups[0].value === property))
  );
}
