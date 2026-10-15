import {
  type Context,
  type Liquid,
  type Parser,
  Tag,
  TagToken,
  type Template,
  type TopLevelToken,
} from "liquidjs";

/** Uses only LiquidJS's public tag/parser extension API; never patches its internals. */
export function registerBasicTags(engine: Liquid): void {
  engine.registerTag(
    "style",
    class extends Tag {
      private readonly body: Template[] = [];
      constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
        super(token, tokens, liquid);
        let closed = false;
        parser
          .parseStream(tokens)
          .on("tag:endstyle", function () {
            closed = true;
            this.stop();
          })
          .on<Template>("template", (template) => this.body.push(template))
          .start();
        if (!closed) throw new Error("Unclosed style tag");
      }
      async render(context: Context) {
        return `<style data-shopify>${await engine.render(this.body, context)}</style>`;
      }
      // biome-ignore lint/correctness/useYield: LiquidJS's public traversal protocol returns children
      *children() {
        return this.body;
      }
    },
  );
  for (const name of ["doc", "javascript", "stylesheet"])
    engine.registerTag(
      name,
      class extends Tag {
        constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid) {
          super(token, tokens, liquid);
          let closed = false;
          while (tokens.length) {
            const next = tokens.shift();
            if (next instanceof TagToken && next.name === `end${name}`) {
              closed = true;
              break;
            }
          }
          if (!closed) throw new Error(`Unclosed ${name} tag`);
          // Raw documentation is ignored; its example tags must never be parsed or executed.
        }
        render() {
          return "";
        }
      },
    );
}
