import {
  type Liquid,
  Output,
  type QuotedToken,
  type TagToken,
  type Template,
  Token,
  Tokenizer,
  TokenKind,
  TypeGuards,
  Value,
} from "liquidjs";

/** Shopify takes quoted content literally; backslashes do not escape or decode characters. */
class LiteralQuotedToken extends Token implements QuotedToken {
  readonly content: string;
  constructor(token: QuotedToken) {
    super(TokenKind.Quoted, token.input, token.begin, token.end, token.file);
    const close = token.input.indexOf(token.input[token.begin] ?? "", token.begin + 1);
    this.content = token.input.slice(token.begin + 1, close);
  }
}

/** Replaces public tag tokenizers before tag constructors, including the liquid statement group. */
export class LiteralTokenizer extends Tokenizer {
  override readQuoted(): QuotedToken | undefined {
    const token = super.readQuoted();
    return token ? new LiteralQuotedToken(token) : undefined;
  }
  override readTopLevelToken(options: Liquid["options"]) {
    const token = super.readTopLevelToken(options);
    if (TypeGuards.isTagToken(token)) adoptTokenizer(token, options);
    return token;
  }
  override readLiquidTagToken(options: Liquid["options"]) {
    const token = super.readLiquidTagToken(options);
    if (token) adoptTokenizer(token, options);
    return token;
  }
}
function adoptTokenizer(token: TagToken, options: Liquid["options"]): void {
  token.tokenizer = new LiteralTokenizer(
    token.input,
    options.operators,
    token.file,
    [token.tokenizer.p, token.tokenizer.N],
    options.groupedExpressions,
  );
}

/** Outputs construct their own tokenizer; replace their public Value while retaining auto-escape. */
export function preserveQuotedOutputs(engine: Liquid, templates: Template[]): void {
  for (const template of templates) {
    if (template instanceof Output) {
      const tokenizer = new LiteralTokenizer(
        template.token.input,
        engine.options.operators,
        template.token.file,
        template.token.contentRange,
        engine.options.groupedExpressions,
      );
      const value = new Value(tokenizer.readFilteredValue(), engine);
      const oldFilters = template.value.filters;
      if (oldFilters.length === value.filters.length + 1) {
        const autoEscape = oldFilters.at(-1);
        if (autoEscape) value.filters.push(autoEscape);
      }
      template.value = value;
      continue;
    }
    const iterator = template.children?.(false, true);
    if (!iterator) continue;
    let next = iterator.next();
    while (!next.done) {
      if (Array.isArray(next.value)) preserveQuotedOutputs(engine, next.value);
      next = iterator.next();
    }
    if (Array.isArray(next.value)) preserveQuotedOutputs(engine, next.value);
  }
}
