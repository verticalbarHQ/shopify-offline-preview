import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";
import { type Liquid, Parser, Token, TokenKind, type TopLevelToken } from "liquidjs";
import { LiteralTokenizer, preserveQuotedOutputs } from "./literal-tokenizer.js";
import { preserveNumericLiterals } from "./numbers.js";

/** Structural HTML token made from the public Token base; retains original file/line offsets. */
class RawBodyToken extends Token {
  trimLeft = 0;
  trimRight = 0;
  constructor(input: string, begin: number, end: number, file: string) {
    super(TokenKind.HTML, input, begin, end, file);
  }
  getContent() {
    return this.input.slice(this.begin + this.trimLeft, this.end - this.trimRight);
  }
}
export function parseLiquid(engine: Liquid, text: string, file: string) {
  if (text.length > engine.options.parseLimit) throw new Error("Liquid parse size limit exceeded");
  const bodies = new Map<number, number>();
  walk(toLiquidAST(text, { mode: "tolerant", allowUnclosedDocumentNode: false }), (node) => {
    if (
      node.type === NodeTypes.LiquidRawTag &&
      ["schema", "doc", "stylesheet", "javascript"].includes(node.name)
    )
      if (node.blockEndPosition.start > node.blockStartPosition.end)
        bodies.set(node.blockStartPosition.end, node.blockEndPosition.start);
  });
  class RawTokenizer extends LiteralTokenizer {
    override readTopLevelToken(options: Liquid["options"]): TopLevelToken {
      const end = bodies.get(this.p);
      if (end !== undefined) {
        const token = new RawBodyToken(text, this.p, end, file);
        this.advance(end - this.p);
        return token;
      }
      return super.readTopLevelToken(options);
    }
  }
  const tokens = new RawTokenizer(text, engine.options.operators, file).readTopLevelTokens(
    engine.options,
  );
  const parsed = new Parser(engine).parseTokens(tokens);
  preserveQuotedOutputs(engine, parsed);
  preserveNumericLiterals(parsed);
  return parsed;
}
