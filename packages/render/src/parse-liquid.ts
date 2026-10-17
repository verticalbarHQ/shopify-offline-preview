import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";
import { type Liquid, Token, TokenKind, type TopLevelToken, TypeGuards } from "liquidjs";
import { dropBlankBodyText } from "./blank-bodies.js";
import { LiteralTokenizer, preserveQuotedOutputs } from "./literal-tokenizer.js";
import { preserveNumericLiterals } from "./numbers.js";
import { RangeParser } from "./range-parser.js";

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
/**
 * Shopify's left trim (`{%-`, `{{-`) leaves the first character of a text run that holds only
 * whitespace, unless the previous tag or output already trimmed that run from its right (`-%}`).
 * LiquidJS removes the whole run, so restore that character after its whitespace control.
 */
function keepFirstWhitespaceOnLeftTrim(tokens: TopLevelToken[]): void {
  for (const token of tokens) {
    if (!TypeGuards.isHTMLToken(token) || token.trimLeft > 0) continue;
    const length = token.end - token.begin;
    if (length > 0 && token.trimRight >= length) token.trimRight = length - 1;
  }
}
export function parseLiquid(
  engine: Liquid,
  text: string,
  file: string,
  onError: (error: unknown, token: Token) => void = (error) => {
    throw error;
  },
) {
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
  keepFirstWhitespaceOnLeftTrim(tokens);
  const parsed = new RangeParser(engine, onError).parseTokens(tokens);
  dropBlankBodyText(parsed);
  preserveQuotedOutputs(engine, parsed);
  preserveNumericLiterals(parsed);
  return parsed;
}
