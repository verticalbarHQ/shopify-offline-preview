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
  Value,
} from "liquidjs";
import {
  type BackupPreviewGuard,
  capturedBackupOutput,
  unknownBackupValue,
} from "./backup-preview.js";
import { liquidOutputValue } from "./filters/core-language.js";
import { prepareRangeArguments, prepareRangeToken, prepareRangeValue } from "./range-values.js";

type ErrorHook = (error: unknown, token: Token) => void;

class BoundTag extends Tag {
  readonly #original: Tag & Template;
  readonly #onError: ErrorHook;
  constructor(
    original: Tag & Template,
    engine: Liquid,
    onError: ErrorHook,
    private readonly backup?: BackupPreviewGuard,
  ) {
    super(original.token, [], engine);
    this.#original = original;
    this.#onError = onError;
  }
  *render(context: Context, emitter: Emitter): Generator<unknown, unknown, unknown> {
    const original = this.#original;
    if (original instanceof IfTag || original instanceof UnlessTag) {
      for (const branch of original.branches) {
        const before = this.backup?.reads(context);
        yield prepareRangeValue(branch.value, context);
        const value = toValue(yield branch.value.value(context, context.opts.lenientIf));
        if (before !== undefined && this.backup?.reads(context) !== before) return;
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
      const before = this.backup?.reads(context);
      yield prepareRangeValue(original.value, context);
      const target = toValue(yield original.value.value(context, context.opts.lenientIf));
      if (before !== undefined && this.backup?.reads(context) !== before) return;
      let hit = false;
      const equal = this.liquid.options.operators["=="];
      if (!equal) throw new Error("Pinned LiquidJS equality operator unavailable");
      for (const branch of original.branches) {
        for (const token of branch.values) {
          const beforeBranch = this.backup?.reads(context);
          yield prepareRangeToken(token, context);
          const value = yield evalTokenValue(token, context, context.opts.lenientIf);
          if (beforeBranch !== undefined && this.backup?.reads(context) !== beforeBranch) return;
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
    const beforeAssignment = original.name === "assign" ? this.backup?.reads(context) : undefined;
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
    if (original.name === "echo") {
      for (const argument of original.arguments?.() ?? []) {
        if (argument instanceof Value) {
          const before = this.backup?.reads(context);
          const value = yield argument.value(context, false);
          const partial = capturedBackupOutput(value);
          if (partial !== undefined) {
            this.backup?.dawn?.recordOutput(context, partial);
            emitter.write(partial);
            return;
          }
          if (
            (before !== undefined && this.backup?.reads(context) !== before) ||
            unknownBackupValue(value)
          )
            return;
          const output = liquidOutputValue(value);
          this.backup?.dawn?.recordOutput(context, output);
          emitter.write(output);
          break;
        }
      }
      return;
    }
    const beforeCapture = original.name === "capture" ? this.backup?.captureReads() : undefined;
    const endCapture = original.name === "capture" ? this.backup?.dawn?.captureMoney() : undefined;
    let result: unknown;
    try {
      result = yield this.#original.render(context, emitter);
    } finally {
      endCapture?.();
    }
    if (beforeCapture !== undefined)
      this.backup?.capture(
        context,
        beforeCapture,
        [...(original.localScope?.() ?? [])][0]?.content,
      );
    if (beforeAssignment !== undefined)
      this.backup?.assignment(
        context,
        beforeAssignment,
        [...(original.localScope?.() ?? [])][0]?.content,
      );
    return result;
  }
  get original(): Tag & Template {
    return this.#original;
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
  backup: BackupPreviewGuard | undefined;
  *render(context: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const before = this.backup?.reads(context);
    yield prepareRangeValue(this.value, context);
    const raw: unknown = yield this.value.value(context, false);
    const partial = capturedBackupOutput(raw);
    if (partial !== undefined) {
      this.backup?.dawn?.recordOutput(context, partial);
      emitter.write(partial);
      return;
    }
    const value = yield toValue(raw);
    if (before !== undefined && this.backup?.reads(context) !== before) return;
    const output = liquidOutputValue(value);
    this.backup?.dawn?.recordOutput(context, output);
    emitter.write(output);
  }
}
/** The tag a parsed template stands for, without the preview's range binding. */
export function unboundTag(template: Template): Template {
  return template instanceof BoundTag ? template.original : template;
}
/** Public parser factory hooks bind SDK-owned range tokens before native tag/value evaluation. */
export class RangeParser extends Parser {
  readonly #engine: Liquid;
  readonly #onError: ErrorHook;
  constructor(
    engine: Liquid,
    onError: ErrorHook,
    private readonly backup?: BackupPreviewGuard,
  ) {
    super(engine);
    this.#engine = engine;
    this.#onError = onError;
  }
  override parseToken(token: TopLevelToken, remaining: TopLevelToken[]) {
    const template = super.parseToken(token, remaining);
    if (template instanceof Tag)
      return new BoundTag(template, this.#engine, this.#onError, this.backup);
    if (template instanceof Output) {
      const output = new BoundOutput(template.token, this.#engine);
      output.backup = this.backup;
      return output;
    }
    return template;
  }
}
