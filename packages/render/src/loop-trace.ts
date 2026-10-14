import { NodeTypes, toLiquidHtmlAST, walk } from "@shopify/liquid-html-parser";
import {
  type Context,
  Drop,
  type Emitter,
  ForTag,
  type Liquid,
  type Parser,
  type TagToken,
  Tokenizer,
  type TopLevelToken,
} from "liquidjs";
import { registerTableRowTag } from "./tablerow-tag.js";

/** Delegates to public metadata methods so saved references retain live indices. */
class ForloopView extends Drop {
  readonly #loop: Drop;
  readonly #context: Context;
  constructor(
    loop: Drop,
    context: Context,
    readonly parentloop: unknown,
  ) {
    super();
    this.#loop = loop;
    this.#context = context;
  }
  #read(property: string): unknown {
    return this.#context.readProperty(this.#loop, property);
  }
  get name() {
    return this.#read("name");
  }
  get length() {
    return this.#read("length");
  }
  index() {
    return this.#read("index");
  }
  index0() {
    return this.#read("index0");
  }
  first() {
    return this.#read("first");
  }
  last() {
    return this.#read("last");
  }
  rindex() {
    return this.#read("rindex");
  }
  rindex0() {
    return this.#read("rindex0");
  }
  valueOf() {
    return this.#loop.valueOf();
  }
}

/** Uses the exported ForTag and Template extension points, preserving native loop control. */
export function registerLoopTrace(
  engine: Liquid,
  execute: (
    value: unknown,
    token: TagToken,
    safeRegion: boolean,
    render: () => Promise<string>,
  ) => Promise<string>,
  onError: (error: unknown, token: TagToken) => string,
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
      *render(context: Context, emitter: Emitter) {
        const saved = context.saveRegister("sop-for-parentloop");
        context.setRegister("sop-for-parentloop", context.getSync(["forloop"]) ?? null);
        try {
          return yield* super.render(context, emitter);
        } finally {
          context.restoreRegister(saved);
        }
      }
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
        super(token, tokens, liquid, parser);
        // Shopify recognizes the standalone keyword before named limit/offset attributes.
        const modifiers = new Tokenizer(token.input, liquid.options.operators, token.file, [
          this.collection.end,
          token.end,
        ]);
        if (modifiers.readIdentifier().content !== "reversed") delete this.hash.hash.reversed;
        const body = this.templates,
          variable = this.variable;
        this.templates = [
          {
            token,
            async render(context: Context, emitter) {
              const loop = context.getSync(["forloop"]);
              if (!(loop instanceof Drop)) throw new Error("Loop metadata unavailable");
              context.push({
                forloop: new ForloopView(loop, context, context.getRegister("sop-for-parentloop")),
              });
              try {
                const output = await execute(
                  context.getSync([variable]),
                  token,
                  safeRegion(token),
                  () => engine.render(body, context),
                );
                emitter.write(output);
              } finally {
                context.pop();
              }
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
  registerTableRowTag(
    engine,
    (value, token, render) => execute(value, token, safeRegion(token), render),
    onError,
  );
}
