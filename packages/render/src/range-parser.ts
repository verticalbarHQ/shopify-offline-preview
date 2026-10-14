import {
  CaseTag,
  type Context,
  type Emitter,
  evalTokenValue,
  IfTag,
  isTruthy,
  type Liquid,
  Output,
  Parser,
  Tag,
  type Template,
  type Token,
  type TopLevelToken,
  toValue,
  UnlessTag,
} from "liquidjs";
import { prepareRangeArguments, prepareRangeToken, prepareRangeValue } from "./range-values.js";

type ErrorHook = (error: unknown, token: Token) => void;

class BoundTag extends Tag {
  readonly #original: Tag & Template;
  readonly #onError: ErrorHook;
  constructor(original: Tag & Template, engine: Liquid, onError: ErrorHook) {
    super(original.token, [], engine);
    this.#original = original;
    this.#onError = onError;
  }
  *render(context: Context, emitter: Emitter): Generator<unknown, unknown, unknown> {
    const original = this.#original;
    if (original instanceof IfTag || original instanceof UnlessTag) {
      for (const branch of original.branches) {
        yield prepareRangeValue(branch.value, context);
        const value = toValue(yield branch.value.value(context, context.opts.lenientIf));
        const matched = "test" in branch ? branch.test(value, context) : isTruthy(value, context);
        if (matched) {
          yield this.liquid.renderer.renderTemplates(branch.templates, context, emitter);
          return;
        }
      }
      yield this.liquid.renderer.renderTemplates(original.elseTemplates ?? [], context, emitter);
      return;
    }
    if (original instanceof CaseTag) {
      yield prepareRangeValue(original.value, context);
      const target = toValue(yield original.value.value(context, context.opts.lenientIf));
      let hit = false;
      const equal = this.liquid.options.operators["=="];
      if (!equal) throw new Error("Pinned LiquidJS equality operator unavailable");
      for (const branch of original.branches) {
        for (const token of branch.values) {
          yield prepareRangeToken(token, context);
          const value = yield evalTokenValue(token, context, context.opts.lenientIf);
          if (yield equal(target, value, context)) {
            yield this.liquid.renderer.renderTemplates(branch.templates, context, emitter);
            hit = true;
            break;
          }
        }
      }
      if (!hit)
        yield this.liquid.renderer.renderTemplates(original.elseTemplates, context, emitter);
      return;
    }
    // These SDK-owned tags evaluate their arguments in their actual binding scopes.
    if (!["include", "render", "cycle"].includes(original.name)) {
      try {
        yield prepareRangeArguments(original, context);
      } catch (error) {
        if (original.name !== "assign") throw error;
        this.#onError(error, original.token);
        return;
      }
    }
    return yield this.#original.render(context, emitter);
  }
  *arguments() {
    yield* this.#original.arguments?.() ?? [];
  }
  *children(partials: boolean, sync: boolean) {
    const iterator = this.#original.children?.(partials, sync);
    if (!iterator) return [];
    return yield* iterator;
  }
  partialScope() {
    return this.#original.partialScope?.();
  }
  blockScope() {
    return this.#original.blockScope?.() ?? [];
  }
  localScope() {
    return this.#original.localScope?.() ?? [];
  }
}
class BoundOutput extends Output {
  *render(context: Context, emitter: Emitter) {
    yield prepareRangeValue(this.value, context);
    return yield* super.render(context, emitter);
  }
}
/** Public parser factory hooks bind SDK-owned range tokens before native tag/value evaluation. */
export class RangeParser extends Parser {
  readonly #engine: Liquid;
  readonly #onError: ErrorHook;
  constructor(engine: Liquid, onError: ErrorHook) {
    super(engine);
    this.#engine = engine;
    this.#onError = onError;
  }
  override parseToken(token: TopLevelToken, remaining: TopLevelToken[]) {
    const template = super.parseToken(token, remaining);
    if (template instanceof Tag) return new BoundTag(template, this.#engine, this.#onError);
    if (template instanceof Output) return new BoundOutput(template.token, this.#engine);
    return template;
  }
}
