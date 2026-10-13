import {
  type Context,
  Hash,
  type Liquid,
  Tag,
  type TagToken,
  type TopLevelToken,
  toPromise,
  type ValueToken,
} from "liquidjs";

interface Binding {
  kind: "with" | "for";
  value: ValueToken;
  alias: string;
}
export function registerRenderTag(
  engine: Liquid,
  render: (name: string, context: Context) => Promise<string>,
  unsupported: () => string,
  trace: (name: string, run: () => Promise<string>) => Promise<string>,
): void {
  engine.registerTag(
    "render",
    class extends Tag {
      private readonly snippetName: string | null;
      private readonly args: Hash;
      private readonly bindings: Binding[] = [];
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
        super(token, tokens, liquid);
        const file = this.tokenizer.readValue();
        const quoted = file && /^(['"])([^'"]+)\1$/.exec(file.getText());
        this.snippetName = quoted?.[2] ?? null;
        if (this.snippetName === null) {
          this.args = new Hash("");
          return;
        }
        while (!this.tokenizer.end()) {
          this.tokenizer.skipBlank();
          const begin = this.tokenizer.p,
            word = this.tokenizer.readIdentifier();
          if (["with", "for"].includes(word.content)) {
            this.tokenizer.skipBlank();
            if (this.tokenizer.peek() !== ":") {
              const value = this.tokenizer.readValue();
              if (!value) throw new Error("render binding requires a value");
              let alias = this.snippetName;
              const beforeAs = this.tokenizer.p;
              if (this.tokenizer.readIdentifier().content === "as") {
                alias = this.tokenizer.readIdentifier().content;
                if (!alias) throw new Error("render alias is required");
              } else this.tokenizer.p = beforeAs;
              this.bindings.push({ kind: word.content === "for" ? "for" : "with", value, alias });
              this.tokenizer.skipBlank();
              if (this.tokenizer.peek() === ",") this.tokenizer.advance();
              continue;
            }
          }
          this.tokenizer.p = begin;
          break;
        }
        this.args = new Hash(this.tokenizer, liquid.options.keyValueSeparator);
      }
      async render(context: Context) {
        if (this.snippetName === null) return unsupported();
        const name = this.snippetName;
        return trace(name, async () => {
          const args: Record<string, unknown> = Object.assign(
            Object.create(null),
            await toPromise(this.args.render(context)),
          );
          let collection: unknown[] | undefined;
          let forAlias: string | undefined;
          for (const binding of this.bindings) {
            const value = await engine.evalValue(binding.value.getText(), context);
            if (binding.kind === "for") {
              collection = Array.isArray(value)
                ? value
                : value === null || value === undefined
                  ? []
                  : [value];
              forAlias = binding.alias;
            } else args[binding.alias] = value;
          }
          if (collection === undefined) return render(name, context.spawn(args));
          let html = "";
          for (let i = 0; i < collection.length; i++) {
            const scope = {
              ...args,
              [forAlias ?? name]: collection[i],
              forloop: {
                length: collection.length,
                index: i + 1,
                index0: i,
                rindex: collection.length - i,
                rindex0: collection.length - i - 1,
                first: i === 0,
                last: i === collection.length - 1,
              },
            };
            html += await render(name, context.spawn(scope));
          }
          return html;
        });
      }
    },
  );
}
