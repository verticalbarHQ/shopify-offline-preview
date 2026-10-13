import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";

export interface InstrumentedSource {
  source: string;
  classicMarkers: number;
  themeBlockMarkers: number;
}

/** Only copies used for comparison are instrumented; normal theme inputs are immutable. */
export function instrumentLiquid(source: string, path: string): InstrumentedSource {
  const ast = toLiquidAST(source, { allowUnclosedDocumentNode: false, mode: "tolerant" });
  const ranges: { start: number; end: number }[] = [];
  walk(ast, (node) => {
    if (node.type !== NodeTypes.LiquidVariableOutput || typeof node.markup === "string") return;
    const expression = node.markup.expression;
    if (expression.type !== NodeTypes.VariableLookup || expression.name !== "block") return;
    if (
      expression.lookups.length !== 1 ||
      expression.lookups[0]?.type !== NodeTypes.String ||
      expression.lookups[0].value !== "shopify_attributes"
    )
      return;
    if (node.markup.filters.length)
      throw new Error(
        `Filtered shopify_attributes needs explicit instrumentation support: ${path}`,
      );
    ranges.push(node.position);
  });
  let output = source;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    output =
      output.slice(0, range.start) +
      'data-sop-block-id="{{ block.id }}" data-sop-block-type="{{ block.type }}"' +
      output.slice(range.end);
  }
  const themeBlock = /^blocks\/[^/]+\.liquid$/.test(path);
  if (themeBlock)
    output = `<!--sop:block {{ block.id }} {{ block.type }}-->${output}<!--/sop:block-->`;
  return { source: output, classicMarkers: ranges.length, themeBlockMarkers: themeBlock ? 1 : 0 };
}
