import {
  type Context,
  Hash,
  type Liquid,
  Tag,
  type TagToken,
  type TopLevelToken,
  TypeGuards,
  type ValueToken,
} from "liquidjs";
import { evalNumericValue } from "./numbers.js";

/** Includes keep the caller's context and registers; all parser state belongs to this tag. */
export function registerIncludeTag(
  engine: Liquid,
  render: (name: string, context: Context) => Promise<string>,
  trace: (name: string, run: () => Promise<string>) => Promise<string>,
): void {
  engine.registerTag(
    "include",
    class extends Tag {
      readonly #file: ValueToken;
      readonly #binding?: ValueToken;
      readonly #alias?: string;
      readonly #args: Hash;
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
        super(token, tokens, liquid);
        const file = this.tokenizer.readValue();
        if (!file) throw new Error("include requires a filename");
        this.#file = file;
        const beforeBinding = this.tokenizer.p;
        const word = this.tokenizer.readIdentifier();
        this.tokenizer.skipBlank();
        if ((word.content === "with" || word.content === "for") && this.tokenizer.peek() !== ":") {
          const value = this.tokenizer.readValue();
          if (!value) throw new Error("include binding requires a value");
          this.#binding = value;
        } else this.tokenizer.p = beforeBinding;
        const beforeAlias = this.tokenizer.p;
        const aliasWord = this.tokenizer.readIdentifier();
        this.tokenizer.skipBlank();
        if (aliasWord.content === "as" && this.tokenizer.peek() !== ":") {
          const alias = this.tokenizer.readIdentifier();
          if (!alias.content) throw new Error("include alias is required");
          this.#alias = alias.content;
        } else this.tokenizer.p = beforeAlias;
        this.#args = new Hash(this.tokenizer, liquid.options.keyValueSeparator);
      }
      *arguments() {
        yield this.#file;
        if (this.#binding) yield this.#binding;
        for (const value of Object.values(this.#args.hash)) if (value) yield value;
      }
      partialScope() {
        if (!TypeGuards.isQuotedToken(this.#file)) return undefined;
        const name = this.#file.content;
        const alias = this.#alias ?? name.split("/").at(-1) ?? name;
        const scope: (string | [string, ValueToken])[] = Object.keys(this.#args.hash);
        if (this.#binding) scope.push([alias, this.#binding]);
        return { name, isolated: false, scope };
      }
      async render(context: Context): Promise<string> {
        const name = await evalNumericValue(engine, this.#file.getText(), context);
        if (typeof name !== "string" || !name)
          throw new Error("include requires a string filename");
        const value = this.#binding
          ? await evalNumericValue(engine, this.#binding.getText(), context)
          : context.getSync([name]);
        const alias = this.#alias ?? name.split("/").at(-1) ?? name;
        return trace(name, async () => {
          const scope: Record<string, unknown> = Object.create(null);
          context.push(scope);
          try {
            for (const [key, token] of Object.entries(this.#args.hash))
              scope[key] = token ? await evalNumericValue(engine, token.getText(), context) : true;
            const items = Array.isArray(value) ? value : [value];
            context.memoryLimit.use(items.length);
            let html = "";
            for (const item of items) {
              context.renderLimit.use(1);
              scope[alias] = item;
              html += await render(name, context);
              if (context.breakCalled || context.continueCalled) break;
            }
            return html;
          } finally {
            context.pop();
          }
        });
      }
    },
  );
}
