import {
  type Context,
  type Liquid,
  Tag,
  type TagToken,
  type TopLevelToken,
  type ValueToken,
} from "liquidjs";
import { evalNumericValue } from "./numbers.js";
/** Named keys such as closest.product use the public tokenizer's value parser. */
export function registerContentFor(
  engine: Liquid,
  render: (kind: string, args: Record<string, unknown>, context: Context) => Promise<string>,
): void {
  engine.registerTag(
    "content_for",
    class extends Tag {
      private readonly kind: ValueToken;
      private readonly args = new Map<string, ValueToken>();
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
        super(token, tokens, liquid);
        const kind = this.tokenizer.readValue();
        if (!kind) throw new Error("content_for type is required");
        if (!/^(?:'blocks?'|"blocks?")$/.test(kind.getText()))
          throw new Error("content_for requires a literal block or blocks type");
        this.kind = kind;
        while (!this.tokenizer.end()) {
          this.tokenizer.skipBlank();
          if (this.tokenizer.peek() === ",") {
            this.tokenizer.advance();
            this.tokenizer.skipBlank();
          }
          if (this.tokenizer.end()) break;
          const key = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/.exec(this.tokenizer.remaining());
          if (!key?.[1]) throw new Error("Invalid content_for named argument");
          this.tokenizer.advance(key[0].length);
          const value = this.tokenizer.readValue();
          if (!value) throw new Error("content_for argument value is required");
          if (this.args.has(key[1])) throw new Error(`Duplicate content_for argument ${key[1]}`);
          if (key[1] === "id" && !/^(?:'[^']+'|"[^"]+")$/.test(value.getText()))
            throw new Error("Static block id must be a nonempty string literal");
          this.args.set(key[1], value);
        }
      }
      async render(context: Context) {
        const kind = String(await evalNumericValue(engine, this.kind.getText(), context));
        if (!["block", "blocks"].includes(kind))
          throw new Error("content_for requires block or blocks");
        const args: Record<string, unknown> = Object.create(null);
        for (const [name, value] of this.args)
          args[name] = await evalNumericValue(engine, value.getText(), context);
        return render(kind, args, context);
      }
    },
  );
}
