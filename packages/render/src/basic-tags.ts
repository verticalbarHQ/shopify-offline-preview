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
export function registerBasicTags(engine: Liquid, unsupported: (message: string) => void): void {
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
    },
  );
  for (const name of ["doc", "javascript", "stylesheet"])
    engine.registerTag(
      name,
      class extends Tag {
        private readonly body: string;
        constructor(token: TagToken, tokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
          super(token, tokens, liquid);
          const body: TopLevelToken[] = [];
          let closed = false;
          while (tokens.length) {
            const next = tokens.shift();
            if (next instanceof TagToken && next.name === `end${name}`) {
              closed = true;
              break;
            }
            if (next) body.push(next);
          }
          if (!closed) throw new Error(`Unclosed ${name} tag`);
          this.body = body.map((token) => token.getText()).join("");
          if (name === "doc") parser.parseTokens(body); // parse examples, never execute them
        }
        render() {
          if (name === "doc") return "";
          unsupported(
            `Shopify's ${name} asset bundling is not implemented; raw code is emitted inline.`,
          );
          return name === "javascript"
            ? `<script>${this.body}</script>`
            : `<style>${this.body}</style>`;
        }
      },
    );
}
