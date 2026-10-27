import { NodeTypes, toLiquidAST, walk } from "@shopify/liquid-html-parser";
import { type Liquid, Token, TokenKind, type TopLevelToken, TypeGuards } from "liquidjs";
import type { BackupPreviewGuard } from "./backup-preview.js";
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
/** Split literal tokens without changing original input offsets or whitespace trimming. */
function unitRegionTokens(
  tokens: TopLevelToken[],
  file: string,
  backup: BackupPreviewGuard | undefined,
): TopLevelToken[] {
  const region = backup?.dawn?.unitRegion(file);
  if (!region) return tokens;
  const boundaries = [
    { at: region.start, markup: region.open },
    { at: region.end, markup: region.close },
  ];
  if (
    !boundaries.every((boundary) =>
      tokens.some(
        (token) =>
          TypeGuards.isHTMLToken(token) && token.begin <= boundary.at && boundary.at <= token.end,
      ),
    )
  )
    return tokens;
  const output: TopLevelToken[] = [];
  const inserted = new Set<number>();
  for (const token of tokens) {
    if (!TypeGuards.isHTMLToken(token)) {
      output.push(token);
      continue;
    }
    let begin = token.begin;
    for (const boundary of boundaries) {
      if (inserted.has(boundary.at) || boundary.at < begin || boundary.at > token.end) continue;
      if (boundary.at > begin) {
        const part = new RawBodyToken(token.input, begin, boundary.at, file);
        part.trimLeft = begin === token.begin ? token.trimLeft : 0;
        part.trimRight = boundary.at === token.end ? token.trimRight : 0;
        output.push(part);
      }
      output.push(new RawBodyToken(boundary.markup, 0, boundary.markup.length, file));
      inserted.add(boundary.at);
      begin = boundary.at;
    }
    if (begin < token.end) {
      const part = new RawBodyToken(token.input, begin, token.end, file);
      part.trimLeft = begin === token.begin ? token.trimLeft : 0;
      part.trimRight = token.trimRight;
      output.push(part);
    }
  }
  return output;
}

export function parseLiquid(
  engine: Liquid,
  text: string,
  file: string,
  onError: (error: unknown, token: Token) => void = (error) => {
    throw error;
  },
  backup?: BackupPreviewGuard,
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
  const parsed = new RangeParser(engine, onError, backup).parseTokens(
    unitRegionTokens(tokens, file, backup),
  );
  dropBlankBodyText(parsed);
  preserveQuotedOutputs(engine, parsed);
  preserveNumericLiterals(parsed);
  return parsed;
}
