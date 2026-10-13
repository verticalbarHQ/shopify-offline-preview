import { NodeTypes, toLiquidHtmlAST, walk } from "@shopify/liquid-html-parser";
import {
  type Context,
  ForTag,
  type Liquid,
  type Parser,
  type TagToken,
  type TopLevelToken,
} from "liquidjs";

/** Uses the exported ForTag and Template extension points, preserving native loop control. */
export function registerLoopTrace(
  engine: Liquid,
  execute: (
    value: unknown,
    token: TagToken,
    safeRegion: boolean,
    render: () => Promise<string>,
  ) => Promise<string>,
): void {
  const ranges = new Map<string, { start: number; end: number }[] | null>();
  function safeRegion(token: TagToken): boolean {
    if (!ranges.has(token.input)) {
      try {
        const unsafe: { start: number; end: number }[] = [];
        walk(
          toLiquidHtmlAST(token.input, { mode: "tolerant", allowUnclosedDocumentNode: false }),
          (node) => {
            if (node.type === NodeTypes.HtmlElement) unsafe.push(node.blockStartPosition);
            else if (
              [
                NodeTypes.HtmlRawNode,
                NodeTypes.HtmlComment,
                NodeTypes.HtmlVoidElement,
                NodeTypes.HtmlSelfClosingElement,
                NodeTypes.AttrSingleQuoted,
                NodeTypes.AttrDoubleQuoted,
                NodeTypes.AttrUnquoted,
              ].includes(node.type)
            )
              unsafe.push(node.position);
            else if (node.type === NodeTypes.LiquidRawTag) unsafe.push(node.position);
          },
        );
        ranges.set(token.input, unsafe);
      } catch {
        ranges.set(token.input, null);
      }
    }
    const unsafe = ranges.get(token.input);
    return (
      !!unsafe && !unsafe.some((range) => token.begin >= range.start && token.begin < range.end)
    );
  }
  engine.registerTag(
    "for",
    class extends ForTag {
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
        super(token, tokens, liquid, parser);
        const body = this.templates,
          variable = this.variable;
        this.templates = [
          {
            token,
            async render(context: Context, emitter) {
              const output = await execute(
                context.getSync([variable]),
                token,
                safeRegion(token),
                () => engine.render(body, context),
              );
              emitter.write(output);
            },
            // biome-ignore lint/correctness/useYield: LiquidJS traversal consumes the generator return value, like ForTag.children.
            *children() {
              return body;
            },
          },
        ];
      }
    },
  );
}
